#!/usr/bin/env node
'use strict';

// Migration 0078 clears the LoRain legacy rain-rate estimates (amount divided by
// the time since the previous received report) and keeps the amount, a
// protocol-verified LoRain rate and every other gauge's rate.
//
// Run: node --test scripts/test-lorain-legacy-rate-migration.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'database/migrations/ordered/0078__clear_lorain_legacy_rain_rate.sql'), 'utf8');
const LORAIN = 'A840410000000061';
const LSN50 = 'A840410000000063';

function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  const device = db.prepare("INSERT INTO devices (deveui, name, type_id, created_at, updated_at) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')");
  device.run(LORAIN, 'Rain', 'AQUASCOPE_LORAIN');
  device.run(LSN50, 'Gauge', 'DRAGINO_LSN50');
  const reading = db.prepare('INSERT INTO device_data (deveui, recorded_at, rain_mm_delta, rain_mm_per_hour, '
    + 'rain_mm_per_10min, counter_interval_seconds, ambient_temperature) VALUES (?, ?, ?, ?, ?, ?, ?)');
  // The old writer: 1 mm after three silent hours reads as 0.333 mm/h.
  reading.run(LORAIN, '2026-10-01T10:00:00.000Z', 1.0, 0.333, 0.06, 10800, 14.5);
  // The contract writer: a verified 15-minute window, no 10-minute value.
  reading.run(LORAIN, '2026-10-01T10:15:00.000Z', 1.0, 4.0, null, 900, null);
  reading.run(LSN50, '2026-10-01T10:00:00.000Z', 0.2, 0.8, 0.13, 900, null);
  return db;
}

function row(db, deveui, recordedAt) {
  return db.prepare('SELECT rain_mm_delta, rain_mm_per_hour, rain_mm_per_10min, counter_interval_seconds, '
    + 'ambient_temperature FROM device_data WHERE deveui = ? AND recorded_at = ?').get(deveui, recordedAt);
}

test('0078 clears only the LoRain elapsed-time estimates', () => {
  const db = seeded();
  try {
    db.exec(MIGRATION);
    assert.deepEqual({ ...row(db, LORAIN, '2026-10-01T10:00:00.000Z') }, {
      rain_mm_delta: 1.0, rain_mm_per_hour: null, rain_mm_per_10min: null,
      counter_interval_seconds: null, ambient_temperature: 14.5,
    });
    assert.deepEqual({ ...row(db, LORAIN, '2026-10-01T10:15:00.000Z') }, {
      rain_mm_delta: 1.0, rain_mm_per_hour: 4.0, rain_mm_per_10min: null,
      counter_interval_seconds: 900, ambient_temperature: null,
    });
    assert.deepEqual({ ...row(db, LSN50, '2026-10-01T10:00:00.000Z') }, {
      rain_mm_delta: 0.2, rain_mm_per_hour: 0.8, rain_mm_per_10min: 0.13,
      counter_interval_seconds: 900, ambient_temperature: null,
    });
  } finally {
    db.close();
  }
});

test('0078 is a no-op when run again', () => {
  const db = seeded();
  try {
    db.exec(MIGRATION);
    const before = db.prepare('SELECT * FROM device_data ORDER BY id').all();
    db.exec(MIGRATION);
    assert.deepEqual(db.prepare('SELECT * FROM device_data ORDER BY id').all(), before);
  } finally {
    db.close();
  }
});
