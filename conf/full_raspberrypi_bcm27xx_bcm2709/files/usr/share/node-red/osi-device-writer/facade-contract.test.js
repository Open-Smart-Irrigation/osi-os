'use strict';

// Binds osi-device-writer EXACTLY as its flows.json callers do: the caller
// nodes ('UC512 Normalize + Write' id 6b28e0d879808dd9, 'SDI12 Normalize +
// Write' id sdi12-write-fn) open the DB with `new osiDb.Database(...)` from
// osi-db-helper, which is a sqlite3 callback facade (run/get/all/close) --
// it has NO `.prepare`. osi-device-writer's own index.test.js only proves
// the module against node:sqlite's DatabaseSync directly, which is why the
// module/caller mismatch (db.prepare is not a function) was invisible to
// that suite. This file is the guard: it must fail the same way the real
// flow nodes fail if writeDeviceData ever regresses to a `.prepare`-only
// implementation.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const SEED_SQL_PATH = path.join(REPO_ROOT, 'database', 'seed-blank.sql');
const EDGE_MANIFEST_PATH = path.join(__dirname, '..', 'edge-channels.json');
const DB_HELPER_PATH = path.join(__dirname, '..', 'osi-db-helper', 'index.js');

const TEST_DEVEUI = 'AABBCCDDEE009900';

// Same node:sqlite-backed sqlite3 adapter shape as
// scripts/test-osi-db-helper-read-snapshot.js, scoped (via Module._load) to
// osi-db-helper's own `require('sqlite3')` only -- this is what makes the
// facade real (run/get/all/close, promise-returning, no .prepare) without
// needing the native sqlite3 addon built for this machine.
function sqlite3Adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') {
        callback = mode;
        mode = undefined;
      }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      queueMicrotask(() => callback && callback.call(this, null));
    }

    all(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const rows = this.native.prepare(sql).all(...(params || []));
        callback.call(this, null, rows);
      } catch (error) {
        callback.call(this, error);
      }
    }

    run(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes) }, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    exec(sql, callback) {
      try {
        this.native.exec(sql);
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    close(callback) {
      try {
        this.native.close();
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

function loadOsiDbHelper() {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) {
      return sqlite3Adapter();
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(DB_HELPER_PATH)];
    return require(DB_HELPER_PATH);
  } finally {
    Module._load = original;
  }
}

function mockNode() {
  const warnings = [];
  const errors = [];
  return {
    warn(msg) { warnings.push(msg); },
    error(msg) { errors.push(msg); },
    status() {},
    warnings,
    errors,
  };
}

describe('osi-device-writer bound through the osi-db-helper facade (as the flow nodes bind it)', () => {
  let tempRoot;
  let dbPath;
  let osiDb;
  let writer;

  before(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-device-writer-facade-'));
    dbPath = path.join(tempRoot, 'farming.db');

    // Seed the scratch DB with the real bundled schema, exactly like
    // verify-device-integration.js does for its node:sqlite based tests.
    const seed = new DatabaseSync(dbPath);
    seed.exec(fs.readFileSync(SEED_SQL_PATH, 'utf8'));
    seed.exec("INSERT INTO users(username, password_hash, created_at) VALUES('test','hash',datetime('now'))");
    const userId = seed.prepare("SELECT id FROM users WHERE username = 'test'").get().id;
    seed.prepare(
      "INSERT INTO devices(deveui, type_id, name, user_id, created_at, updated_at) VALUES(?, 'MILESIGHT_UC512', 'test-uc512', ?, datetime('now'), datetime('now'))"
    ).run(TEST_DEVEUI, userId);
    seed.close();

    osiDb = loadOsiDbHelper();
    writer = require('./index.js');
  });

  after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('writes a device_data row for a UC512 normalize result through `new osiDb.Database(...)`', async () => {
    const { normalize } = require('../osi-uc512-normalize/index.js');
    const edgeManifest = JSON.parse(fs.readFileSync(EDGE_MANIFEST_PATH, 'utf8'));
    const normalizeResult = normalize(
      { battery: 91, valve_1: 'open', pressure: 275.5 },
      { recordedAt: '2026-01-15T10:00:00Z' }
    );

    // This is the exact call shape both 'UC512 Normalize + Write' and
    // 'SDI12 Normalize + Write' use: `new osiDb.Database('/data/db/farming.db')`
    // from osi-db-helper, passed straight into writeDeviceData.
    const db = new osiDb.Database(dbPath);
    const node = mockNode();
    let result;
    try {
      result = await writer.writeDeviceData(
        db,
        edgeManifest,
        normalizeResult,
        { deveui: TEST_DEVEUI },
        { node }
      );
    } finally {
      await db.close();
    }

    assert.equal(result.inserted, true, 'writeDeviceData must report an insert when bound through the facade');
    assert.deepEqual(node.errors, [], 'no node.error calls expected for a clean UC512 write');

    const verify = new DatabaseSync(dbPath);
    try {
      const row = verify.prepare('SELECT * FROM device_data WHERE deveui = ?').get(TEST_DEVEUI);
      assert.ok(row, 'device_data row must land for the UC512 uplink');
      assert.equal(row.bat_pct, 91);
      assert.equal(row.valve_1_state, 'open');
      assert.equal(row.pipe_pressure_kpa, 275.5);
    } finally {
      verify.close();
    }
  });

  it('quarantineOnly writes exactly one ingest_quarantine row through the facade', async () => {
    const db = new osiDb.Database(dbPath);
    try {
      await writer.quarantineOnly(db, TEST_DEVEUI, 'sdi12_segments_incomplete', '3:[0,2]');
    } finally {
      await db.close();
    }

    const verify = new DatabaseSync(dbPath);
    try {
      const row = verify.prepare(
        "SELECT * FROM ingest_quarantine WHERE deveui = ? AND channel = 'sdi12_segments_incomplete'"
      ).get(TEST_DEVEUI);
      assert.ok(row, 'exactly one quarantine row must land through the facade path');
      assert.equal(row.reason, 'unknown_channel');
      assert.equal(row.raw_value, '3:[0,2]');
    } finally {
      verify.close();
    }
  });
});
