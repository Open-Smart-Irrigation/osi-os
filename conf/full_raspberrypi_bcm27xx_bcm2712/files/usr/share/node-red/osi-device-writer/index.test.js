'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const writer = require('./index.js');
const { writeDeviceData, clampRecordedAt, resetColumnCache } = writer;

const repoRoot = path.resolve(__dirname, '../../../../../../..');
const { createAsyncDatabaseFacade } = require(
  path.join(repoRoot, 'scripts/lib/database-sync-async-facade.js')
);

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

// A counting wrapper around the shipped async facade so tests can observe how
// many times PRAGMA table_info(device_data) is actually executed, without
// creating a second CommonJS database contract. It still satisfies the
// no-`prepare`-member negative control.
function createCountingFacade(syncDb) {
  const inner = createAsyncDatabaseFacade(syncDb);
  let schemaReadCount = 0;
  const facade = Object.freeze({
    async all(sql, params) {
      if (typeof sql === 'string' && sql.indexOf('PRAGMA table_info') === 0) {
        schemaReadCount++;
      }
      return inner.all(sql, params);
    },
    async get(sql, params) {
      return inner.get(sql, params);
    },
    async run(sql, params) {
      return inner.run(sql, params);
    },
    close() {
      return inner.close();
    },
  });
  return { facade, getSchemaReadCount: () => schemaReadCount };
}

describe('osi-device-writer', () => {
  let syncDb;
  let writerDb;

  beforeEach(() => {
    resetColumnCache();
    syncDb = createTestDb();
    writerDb = createAsyncDatabaseFacade(syncDb);
  });

  afterEach(() => {
    syncDb.close();
  });

  it('exposes no prepare member on the async facade passed to the writer', () => {
    assert.equal(writerDb.prepare, undefined);
  });

  it('inserts known channels through the shipped async database contract', async () => {
    const result = await writeDeviceData(
      writerDb,
      minimalManifest(),
      { channels: { swt_1: 42.5, ambient_temperature: 23.1 }, unknown: {} },
      { deveui: TEST_DEVEUI },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    assert.deepEqual(result.deadLettered, []);
    assert.ok(result.columns.includes('swt_1'));
    assert.ok(result.columns.includes('ambient_temperature'));

    const row = syncDb.prepare('SELECT * FROM device_data WHERE deveui = ?').get(TEST_DEVEUI);
    assert.equal(row.swt_1, 42.5);
    assert.equal(row.ambient_temperature, 23.1);
  });

  it('dead-letters unknown channels', async () => {
    const result = await writeDeviceData(
      writerDb,
      minimalManifest(),
      { channels: { swt_1: 10 }, unknown: { mystery_field: 99 } },
      { deveui: TEST_DEVEUI },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    assert.equal(result.deadLettered.length, 1);
    assert.equal(result.deadLettered[0].channel, 'mystery_field');
    assert.equal(result.deadLettered[0].reason, 'unknown_channel');

    const q = syncDb.prepare('SELECT * FROM ingest_quarantine WHERE channel = ?').get('mystery_field');
    assert.ok(q);
    assert.equal(q.reason, 'unknown_channel');
  });

  it('dead-letters server-only channels (edgeField null)', async () => {
    const result = await writeDeviceData(
      writerDb,
      minimalManifest(),
      { channels: { swt_1: 10, vwc: 35 }, unknown: {} },
      { deveui: TEST_DEVEUI },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    assert.equal(result.deadLettered.length, 1);
    assert.equal(result.deadLettered[0].channel, 'vwc');
    assert.equal(result.deadLettered[0].reason, 'server_only_channel');
  });

  it('dead-letters unmapped channels', async () => {
    const result = await writeDeviceData(
      writerDb,
      minimalManifest(),
      { channels: { swt_1: 10, totally_new_thing: 42 }, unknown: {} },
      { deveui: TEST_DEVEUI },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.deadLettered.length, 1);
    assert.equal(result.deadLettered[0].reason, 'unmapped_channel');
  });

  it('clamps implausible timestamps', async () => {
    const node = mockNode();
    const result = await writeDeviceData(
      writerDb,
      minimalManifest(),
      {
        channels: { swt_1: 10 },
        unknown: {},
        recordedAt: '2020-01-01T00:00:00Z',
      },
      { deveui: TEST_DEVEUI },
      { node, nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    assert.ok(node.warnings.length > 0);
    assert.ok(node.warnings[0].includes('timestamp_clamped'));

    const row = syncDb.prepare('SELECT recorded_at FROM device_data WHERE deveui = ?').get(TEST_DEVEUI);
    assert.equal(row.recorded_at, '2026-01-15T10:00:00.000Z');
  });

  it('shadow mode returns row without INSERT', async () => {
    const result = await writeDeviceData(
      writerDb,
      minimalManifest(),
      { channels: { swt_1: 42.5 }, unknown: {} },
      { deveui: TEST_DEVEUI },
      { node: mockNode(), shadow: true, nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, false);
    assert.ok(result.shadowRow);
    assert.equal(result.shadowRow.swt_1, 42.5);
    assert.equal(result.shadowRow.deveui, TEST_DEVEUI);

    const count = syncDb.prepare('SELECT COUNT(*) as c FROM device_data').get();
    assert.equal(count.c, 0);
  });

  it('handles SQL-hostile values via parameterization', async () => {
    const manifest = [
      { key: 'valve_1_state', edgeField: 'valve_1_state', unit: null },
    ];
    const result = await writeDeviceData(
      writerDb,
      manifest,
      { channels: { valve_1_state: "open'); DROP TABLE device_data;--" }, unknown: {} },
      { deveui: TEST_DEVEUI },
      { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, true);
    const tables = syncDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_data'").get();
    assert.ok(tables);

    const row = syncDb.prepare('SELECT valve_1_state FROM device_data WHERE deveui = ?').get(TEST_DEVEUI);
    assert.equal(row.valve_1_state, "open'); DROP TABLE device_data;--");
  });

  it('rejects empty deveui', async () => {
    const node = mockNode();
    const result = await writeDeviceData(
      writerDb,
      minimalManifest(),
      { channels: { swt_1: 10 }, unknown: {} },
      { deveui: '' },
      { node, nowMs: Date.parse('2026-01-15T10:00:00Z') }
    );

    assert.equal(result.inserted, false);
    assert.ok(node.errors.length > 0);
  });

  describe('hard schema-mismatch behavior (fail-closed)', () => {
    it('rejects with DEVICE_DATA_SCHEMA_MISMATCH and inserts no partial row', async () => {
      const driftedManifest = [
        { key: 'swt_1', edgeField: 'swt_1', unit: 'kPa' },
        { key: 'fake', edgeField: 'nonexistent_column_xyz', unit: null },
      ];
      const node = mockNode();

      await assert.rejects(
        writeDeviceData(
          writerDb,
          driftedManifest,
          { channels: { swt_1: 42.5, fake: 99 }, unknown: {} },
          { deveui: TEST_DEVEUI },
          { node, nowMs: Date.parse('2026-01-15T10:00:00Z') }
        ),
        (error) => error.code === 'DEVICE_DATA_SCHEMA_MISMATCH'
      );

      // No partial row: even the valid swt_1 column must not have been inserted.
      const count = syncDb.prepare('SELECT COUNT(*) AS n FROM device_data').get().n;
      assert.equal(count, 0);

      const q = syncDb.prepare(
        "SELECT * FROM ingest_quarantine WHERE channel = 'fake' AND reason = 'column_missing'"
      ).get();
      assert.ok(q, 'exactly one column_missing quarantine row must exist');
      assert.ok(node.errors.length > 0);
    });

    it('never reports inserted: true for a schema-mismatched call', async () => {
      const driftedManifest = [
        { key: 'fake', edgeField: 'nonexistent_column_xyz', unit: null },
      ];

      await assert.rejects(
        writeDeviceData(
          writerDb,
          driftedManifest,
          { channels: { fake: 1 }, unknown: {} },
          { deveui: TEST_DEVEUI },
          { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
        )
      );
    });

    it('invalidates the module-global column cache and permits a retry after in-place repair', async () => {
      const { facade, getSchemaReadCount } = createCountingFacade(syncDb);
      const driftedManifest = [
        { key: 'swt_1', edgeField: 'swt_1', unit: 'kPa' },
        { key: 'fresh', edgeField: 'freshly_added_column', unit: null },
      ];

      await assert.rejects(
        writeDeviceData(
          facade,
          driftedManifest,
          { channels: { swt_1: 1, fresh: 2 }, unknown: {} },
          { deveui: TEST_DEVEUI },
          { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:00Z') }
        ),
        (error) => error.code === 'DEVICE_DATA_SCHEMA_MISMATCH'
      );
      assert.equal(syncDb.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 0);
      assert.equal(getSchemaReadCount(), 1);

      // Simulate an in-place schema repair (no module restart, no resetColumnCache()).
      syncDb.exec('ALTER TABLE device_data ADD COLUMN freshly_added_column REAL');

      const retried = await writeDeviceData(
        facade,
        driftedManifest,
        { channels: { swt_1: 1, fresh: 2 }, unknown: {} },
        { deveui: TEST_DEVEUI },
        { node: mockNode(), nowMs: Date.parse('2026-01-15T10:00:01Z') }
      );

      assert.equal(retried.inserted, true);
      assert.equal(getSchemaReadCount(), 2);
      assert.equal(syncDb.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 1);
    });
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
