'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const policy = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-rejection-recovery');

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
);
CREATE TABLE queue_probe (value TEXT NOT NULL);
`;

function receipt(eventUuid = 'event-1') {
  return {
    cloudReplayRequest: {
      eventUuid,
      expectedGatewayEui: 'AABBCCDDEEFF0011',
      expectedReason: 'ownership_precondition_missing',
    },
    cloudReplayResponse: {
      eventUuid,
      outcome: 'APPLIED',
      reason: null,
      replayAttemptCount: 0,
      attemptedAt: '2026-09-23T10:00:00.000Z',
    },
  };
}

function makeDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-recovery-queue-')), 'farming.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sync_outbox
    (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui,
     rejected_at, rejection_reason, rejection_code, rejection_class)
    VALUES (?, 'DEVICE_DATA', 'k1', 'DEVICE_DATA_APPENDED', '{"value":1}', 2,
            '2026-09-23T09:00:00Z', 'AABBCCDDEEFF0011', '2026-09-23T09:30:00Z',
            'diagnostic', 'ownership_precondition_missing', 'REPAIRABLE')`).run('event-1');
  db.close();
  return file;
}

class QueueFaithfulDatabase {
  static states = new Map();

  static reset() {
    for (const state of QueueFaithfulDatabase.states.values()) state.db.close();
    QueueFaithfulDatabase.states.clear();
  }

  static stateFor(file) {
    let state = QueueFaithfulDatabase.states.get(file);
    if (!state) {
      state = { db: new DatabaseSync(file), queue: Promise.resolve(), sql: [], before: null };
      QueueFaithfulDatabase.states.set(file, state);
    }
    return state;
  }

  constructor(file) {
    this.state = QueueFaithfulDatabase.stateFor(file);
  }

  enqueue(operation) {
    const scheduled = this.state.queue.catch(() => undefined).then(() => operation());
    this.state.queue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  run(sql, params, callback) {
    return this.enqueue(() => {
      this.state.sql.push(sql);
      if (this.state.before) this.state.before(sql, this);
      const result = this.state.db.prepare(sql).run(...(params || []));
      if (typeof callback === 'function') process.nextTick(() => callback.call(result, null));
      return result;
    });
  }

  all(sql, params, callback) {
    return this.enqueue(() => {
      this.state.sql.push(sql);
      if (this.state.before) this.state.before(sql, this);
      const rows = this.state.db.prepare(sql).all(...(params || []));
      if (typeof callback === 'function') process.nextTick(() => callback(null, rows));
      return rows;
    });
  }

  transaction(executor) {
    return this.enqueue(async () => {
      this.state.sql.push('BEGIN IMMEDIATE');
      if (this.state.before) this.state.before('BEGIN IMMEDIATE', this);
      this.state.db.exec('BEGIN IMMEDIATE');
      const tx = {
        all: async (sql, params = []) => {
          this.state.sql.push(sql);
          return this.state.db.prepare(sql).all(...params);
        },
        get: async (sql, params = []) => {
          this.state.sql.push(sql);
          return this.state.db.prepare(sql).get(...params);
        },
        run: async (sql, params = []) => {
          this.state.sql.push(sql);
          return this.state.db.prepare(sql).run(...params);
        },
      };
      try {
        const result = await executor(tx);
        this.state.sql.push('COMMIT');
        this.state.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.state.sql.push('ROLLBACK');
        this.state.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  close(callback) {
    if (typeof callback === 'function') process.nextTick(() => callback(null));
  }
}

async function recover(file, execute = false) {
  return policy.recoverOutbox({
    Database: QueueFaithfulDatabase,
    dbPath: file,
    eventUuids: ['event-1'],
    receipts: [receipt()],
    execute,
  });
}

test('execute transaction keeps a queued sibling operation outside its commit', async () => {
  const file = makeDb();
  const state = QueueFaithfulDatabase.stateFor(file);
  const sibling = new QueueFaithfulDatabase(file);
  let scheduled = false;
  state.before = (sql) => {
    if (sql === 'BEGIN IMMEDIATE' && !scheduled) {
      scheduled = true;
      sibling.run('INSERT INTO queue_probe (value) VALUES (?)', ['sibling']);
    }
  };
  try {
    const result = await recover(file, true);
    assert.equal(result.changed, 1);
    await state.queue;
    const commitIndex = state.sql.indexOf('COMMIT');
    const siblingIndex = state.sql.findIndex((sql) => sql.startsWith('INSERT INTO queue_probe'));
    assert.ok(commitIndex >= 0, 'recovery must commit its transaction');
    assert.ok(siblingIndex > commitIndex, 'queued sibling must run after recovery commit');
  } finally {
    QueueFaithfulDatabase.reset();
  }
});

test('dry run performs read validation without opening or rolling back a transaction', async () => {
  const file = makeDb();
  const state = QueueFaithfulDatabase.stateFor(file);
  try {
    await recover(file, false);
    assert.deepEqual(state.sql.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)), []);
    assert.equal(state.sql.some((sql) => sql.startsWith('INSERT INTO sync_outbox_recovery_audit')), false);
    assert.equal(state.sql.some((sql) => sql.startsWith('UPDATE sync_outbox SET')), false);
  } finally {
    QueueFaithfulDatabase.reset();
  }
});
