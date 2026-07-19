'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const { writeDeviceData, clampRecordedAt, resetColumnCache } = require('./index.js');

const seedPath = path.resolve(__dirname, '../../../../../../..', 'database', 'seed-blank.sql');
const seedSql = fs.readFileSync(seedPath, 'utf8');

const TEST_DEVEUI = 'AABBCCDDEE001122';

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(seedSql);
  db.exec("INSERT INTO users(username, password_hash, created_at) VALUES('test','hash',datetime('now'))");
  const userId = db.prepare("SELECT id FROM users WHERE username = 'test'").get().id;
  db.prepare(
    "INSERT INTO devices(deveui, type_id, name, user_id, created_at, updated_at) VALUES(?, 'DRAGINO_LSN50', 'test-dev', ?, datetime('now'), datetime('now'))"
  ).run(TEST_DEVEUI, userId);
  return db;
}

function minimalManifest() {
  return [
    { key: 'swt_1', edgeField: 'swt_1', unit: 'kPa' },
    { key: 'ambient_temperature', edgeField: 'ambient_temperature', unit: '°C' },
    { key: 'vwc', edgeField: null, unit: '%' },
  ];
}

function mockNode() {
  const warnings = [];
  const errors = [];
  return {
    warn(msg) { warnings.push(msg); },
    error(msg) { errors.push(msg); },
    warnings,
    errors,
  };
}

describe('osi-device-writer', () => {
  let db;

  beforeEach(() => {
    resetColumnCache();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('inserts known channels correctly', () => {
    const result = writeDeviceData(
      db,
      minimalManifest(),
      { channels: { swt_1: 42.5, ambient_temperature: 23.1 }, unknown: {} },
      { deveui: 'AABBCCDDEE001122' },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    assert.deepEqual(result.deadLettered, []);
    assert.ok(result.columns.includes('swt_1'));
    assert.ok(result.columns.includes('ambient_temperature'));

    const row = db.prepare('SELECT * FROM device_data WHERE deveui = ?').get('AABBCCDDEE001122');
    assert.equal(row.swt_1, 42.5);
    assert.equal(row.ambient_temperature, 23.1);
  });

  it('dead-letters unknown channels', () => {
    const result = writeDeviceData(
      db,
      minimalManifest(),
      { channels: { swt_1: 10 }, unknown: { mystery_field: 99 } },
      { deveui: 'AABBCCDDEE001122' },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    assert.equal(result.deadLettered.length, 1);
    assert.equal(result.deadLettered[0].channel, 'mystery_field');
    assert.equal(result.deadLettered[0].reason, 'unknown_channel');

    const q = db.prepare('SELECT * FROM ingest_quarantine WHERE channel = ?').get('mystery_field');
    assert.ok(q);
    assert.equal(q.reason, 'unknown_channel');
  });

  it('dead-letters server-only channels (edgeField null)', () => {
    const result = writeDeviceData(
      db,
      minimalManifest(),
      { channels: { swt_1: 10, vwc: 35 }, unknown: {} },
      { deveui: 'AABBCCDDEE001122' },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    assert.equal(result.deadLettered.length, 1);
    assert.equal(result.deadLettered[0].channel, 'vwc');
    assert.equal(result.deadLettered[0].reason, 'server_only_channel');
  });

  it('dead-letters unmapped channels', () => {
    const result = writeDeviceData(
      db,
      minimalManifest(),
      { channels: { swt_1: 10, totally_new_thing: 42 }, unknown: {} },
      { deveui: 'AABBCCDDEE001122' },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.deadLettered.length, 1);
    assert.equal(result.deadLettered[0].reason, 'unmapped_channel');
  });

  it('hard-errors when edgeField names a non-existent column', () => {
    const badManifest = [
      { key: 'fake', edgeField: 'nonexistent_column_xyz', unit: null },
    ];
    const node = mockNode();

    const result = writeDeviceData(
      db,
      badManifest,
      { channels: { fake: 42 }, unknown: {} },
      { deveui: 'AABBCCDDEE001122' },
      { node, nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.deadLettered.length, 1);
    assert.equal(result.deadLettered[0].reason, 'column_missing');
    assert.ok(node.errors.length > 0);
  });

  it('clamps implausible timestamps', () => {
    const node = mockNode();
    const result = writeDeviceData(
      db,
      minimalManifest(),
      {
        channels: { swt_1: 10 },
        unknown: {},
        recordedAt: '2020-01-01T00:00:00Z',
      },
      { deveui: 'AABBCCDDEE001122' },
      { node, nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    assert.ok(node.warnings.length > 0);
    assert.ok(node.warnings[0].includes('timestamp_clamped'));

    const row = db.prepare('SELECT recorded_at FROM device_data WHERE deveui = ?').get('AABBCCDDEE001122');
    assert.equal(row.recorded_at, '2026-01-15T10:00:00.000Z');
  });

  it('shadow mode returns row without INSERT', () => {
    const result = writeDeviceData(
      db,
      minimalManifest(),
      { channels: { swt_1: 42.5 }, unknown: {} },
      { deveui: 'AABBCCDDEE001122' },
      { node: mockNode(), shadow: true, nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, false);
    assert.ok(result.shadowRow);
    assert.equal(result.shadowRow.swt_1, 42.5);
    assert.equal(result.shadowRow.deveui, 'AABBCCDDEE001122');

    const count = db.prepare('SELECT COUNT(*) as c FROM device_data').get();
    assert.equal(count.c, 0);
  });

  it('handles SQL-hostile values via parameterization', () => {
    const manifest = [
      { key: 'valve_1_state', edgeField: 'valve_1_state', unit: null },
    ];
    const result = writeDeviceData(
      db,
      manifest,
      { channels: { valve_1_state: "open'); DROP TABLE device_data;--" }, unknown: {} },
      { deveui: 'AABBCCDDEE001122' },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_data'").get();
    assert.ok(tables);

    const row = db.prepare('SELECT valve_1_state FROM device_data WHERE deveui = ?').get('AABBCCDDEE001122');
    assert.equal(row.valve_1_state, "open'); DROP TABLE device_data;--");
  });

  it('rejects empty deveui', () => {
    const node = mockNode();
    const result = writeDeviceData(
      db,
      minimalManifest(),
      { channels: { swt_1: 10 }, unknown: {} },
      { deveui: '' },
      { node, nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, false);
    assert.ok(node.errors.length > 0);
  });
});

describe('clampRecordedAt', () => {
  const now = Date.parse('2026-01-15T10:00:00Z');

  it('passes through valid timestamps', () => {
    const r = clampRecordedAt('2026-01-15T09:00:00Z', now);
    assert.equal(r.clamped, false);
    assert.equal(r.recordedAt, '2026-01-15T09:00:00Z');
  });

  it('clamps timestamps before floor', () => {
    const r = clampRecordedAt('2023-12-31T23:59:59Z', now);
    assert.equal(r.clamped, true);
  });

  it('clamps timestamps too far in the future', () => {
    const r = clampRecordedAt('2026-01-15T12:00:01Z', now);
    assert.equal(r.clamped, true);
  });

  it('returns nowIso for null/undefined/empty', () => {
    assert.equal(clampRecordedAt(null, now).clamped, false);
    assert.equal(clampRecordedAt(undefined, now).clamped, false);
    assert.equal(clampRecordedAt('', now).clamped, false);
  });
});
