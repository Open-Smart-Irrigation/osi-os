'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const flow = JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json', 'utf8'));
const guardSource = flow.find((node) => node.id === 'sync-outbox-recover-admin-guard').func;
const workerSource = flow.find((node) => node.id === 'sync-outbox-recover-fn').func;
const policy = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-rejection-recovery');

function runGuard(msg, authorizeAdminRead) {
  return new Function('msg', 'osiLib', 'env', 'node', 'global', guardSource)(
    msg,
    { require: (name) => name === 'scope' ? { ok: true, value: { authorizeAdminRead } } : { ok: true, value: {} } },
    { get: () => 'test-secret' },
    { error: () => {}, warn: () => {} },
    { get: () => ({}) },
  );
}

test('recovery route returns 401 for anonymous and 403 for authenticated non-admin', async () => {
  const anonymous = await runGuard({ req: { headers: {} } }, async () => { const error = new Error('Unauthorized'); error.statusCode = 401; throw error; });
  assert.equal(anonymous[1].statusCode, 401);
  let writes = 0;
  const nonAdmin = await runGuard({ req: { headers: { authorization: 'Bearer valid' } } }, async () => { const error = new Error('Forbidden'); error.statusCode = 403; throw error; });
  assert.equal(nonAdmin[1].statusCode, 403);
  assert.equal(writes, 0);
  const admin = await runGuard({ req: { headers: { authorization: 'Bearer valid' } } }, async () => ({ username: 'admin' }));
  assert.equal(admin[0]._recoveryActor, 'admin');
});

const SCHEMA = `
CREATE TABLE sync_outbox (
  event_uuid TEXT PRIMARY KEY, aggregate_type TEXT NOT NULL, aggregate_key TEXT NOT NULL,
  op TEXT NOT NULL, payload_json TEXT NOT NULL, sync_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL, gateway_device_eui TEXT NOT NULL, delivered_at TEXT,
  rejected_at TEXT, rejection_reason TEXT, rejection_code TEXT, rejection_class TEXT,
  retry_count INTEGER NOT NULL DEFAULT 3, last_retryable_failure_at TEXT,
  recovery_generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sync_outbox_recovery_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_uuid TEXT NOT NULL, generation INTEGER NOT NULL,
  actor TEXT NOT NULL, attempted_at TEXT NOT NULL, previous_rejection_code TEXT,
  previous_rejection_class TEXT, previous_rejection_reason TEXT, envelope_sha256 TEXT NOT NULL,
  receipt_json TEXT NOT NULL, UNIQUE(event_uuid, generation)
);`;

class CallbackDatabase {
  constructor(_path) { this.db = CallbackDatabase.db; }
  all(sql, params, callback) { try { callback(null, this.db.prepare(sql).all(...(params || []))); } catch (error) { callback(error); } }
  run(sql, params, callback) { try { const result = this.db.prepare(sql).run(...(params || [])); callback.call(result, null); } catch (error) { callback(error); } }
  async transaction(executor) {
    this.db.exec('BEGIN IMMEDIATE');
    const tx = {
      all: async (sql, params = []) => this.db.prepare(sql).all(...params),
      get: async (sql, params = []) => this.db.prepare(sql).get(...params),
      run: async (sql, params = []) => this.db.prepare(sql).run(...params),
    };
    try {
      const result = await executor(tx);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(callback) { callback(); }
}

function receipt(eventUuid = 'event-1', outcome = 'APPLIED') {
  return {
    cloudReplayRequest: { eventUuid, expectedGatewayEui: 'AABBCCDDEEFF0011', expectedReason: 'ownership_precondition_missing' },
    cloudReplayResponse: { eventUuid, outcome, reason: null, replayAttemptCount: 0, attemptedAt: '2026-09-23T10:00:00.000Z' },
  };
}

function runWorker(db, payload) {
  CallbackDatabase.db = db;
  return new Function('msg', 'osiLib', 'osiDb', 'node', workerSource)(
    { payload, _recoveryActor: 'admin' },
    { require: (name) => name === 'rejection-recovery' ? { ok: true, value: policy } : { ok: false, error: name } },
    { Database: CallbackDatabase },
    { warn: () => {} },
  );
}

function makeDb() {
  const db = new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-recover-route-')), 'farming.db'));
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sync_outbox
    (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui,
     rejected_at, rejection_reason, rejection_code, rejection_class)
    VALUES (?, 'DEVICE_DATA', 'k1', 'DEVICE_DATA_APPENDED', '{"value":1}', 2, '2026-09-23T09:00:00Z', 'AABBCCDDEEFF0011', '2026-09-23T09:30:00Z', 'diagnostic', 'ownership_precondition_missing', 'REPAIRABLE')`).run('event-1');
  return db;
}

test('dry run validates receipts without mutation, execute commits audit and generation one', async () => {
  const db = makeDb();
  try {
    const body = { eventUuids: ['event-1'], receipts: [receipt()] };
    const dry = await runWorker(db, body);
    assert.equal(dry.statusCode, 200);
    assert.equal(dry.payload.changed, 0);
    assert.equal(db.prepare('SELECT recovery_generation, rejected_at FROM sync_outbox WHERE event_uuid = ?').get('event-1').recovery_generation, 0);
    const executed = await runWorker(db, { ...body, execute: true });
    assert.equal(executed.statusCode, 200);
    assert.equal(executed.payload.changed, 1);
    const row = db.prepare('SELECT recovery_generation, rejected_at, retry_count FROM sync_outbox WHERE event_uuid = ?').get('event-1');
    assert.equal(row.recovery_generation, 1);
    assert.equal(row.rejected_at, null);
    assert.equal(row.retry_count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox_recovery_audit').get().n, 1);
    const second = await runWorker(db, { ...body, execute: true });
    assert.equal(second.statusCode, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox_recovery_audit').get().n, 1);
  } finally { db.close(); }
});

test('execute validates every row before mutation', async () => {
  const db = makeDb();
  try {
    const result = await runWorker(db, { execute: true, eventUuids: ['event-1', 'missing'], receipts: [receipt('event-1'), receipt('missing')] });
    assert.equal(result.statusCode, 400);
    assert.equal(db.prepare('SELECT recovery_generation FROM sync_outbox WHERE event_uuid = ?').get('event-1').recovery_generation, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox_recovery_audit').get().n, 0);
  } finally { db.close(); }
});
