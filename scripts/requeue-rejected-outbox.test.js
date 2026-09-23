'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, 'requeue-rejected-outbox.js');
const RECEIPT = {
  cloudReplayRequest: {
    eventUuid: 'event-1',
    expectedGatewayEui: 'AABBCCDDEEFF0011',
    expectedReason: 'ownership_precondition_missing',
  },
  cloudReplayResponse: {
    eventUuid: 'event-1',
    outcome: 'APPLIED',
    reason: null,
    replayAttemptCount: 1,
    attemptedAt: '2026-09-23T10:00:00.000Z',
  },
};

const SCHEMA = `
CREATE TABLE sync_outbox (
  event_uuid TEXT PRIMARY KEY, aggregate_type TEXT NOT NULL, aggregate_key TEXT NOT NULL,
  op TEXT NOT NULL, payload_json TEXT NOT NULL, sync_version INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL, delivered_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui TEXT, rejected_at TEXT, rejection_reason TEXT,
  last_retryable_failure_at TEXT, rejection_code TEXT, rejection_class TEXT,
  recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK (recovery_generation IN (0, 1))
);
CREATE TABLE sync_outbox_recovery_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_uuid TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation = 1), actor TEXT NOT NULL,
  attempted_at TEXT NOT NULL, previous_rejection_code TEXT,
  previous_rejection_class TEXT, previous_rejection_reason TEXT,
  envelope_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL,
  UNIQUE(event_uuid, generation)
);
`;

function makeDb(rows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-recovery-'));
  const dbPath = path.join(dir, 'farming.db');
  const receiptPath = path.join(dir, 'receipt.json');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT INTO sync_outbox
    (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at,
     delivered_at, retry_count, gateway_device_eui, rejected_at, rejection_reason,
     last_retryable_failure_at, rejection_code, rejection_class, recovery_generation)
    VALUES (?, 'DEVICE_DATA', 'k1', 'DEVICE_DATA_APPENDED', ?, 2, '2026-09-23T09:00:00Z', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(
      row.eventUuid, row.payloadJson || '{"value":1}', row.deliveredAt || null,
      row.retryCount === undefined ? 4 : row.retryCount, row.gateway || 'AABBCCDDEEFF0011',
      row.rejectedAt === undefined ? '2026-09-23T09:30:00Z' : row.rejectedAt,
      row.rejectionReason === undefined ? 'owner missing' : row.rejectionReason,
      row.lastRetryableFailureAt === undefined ? '2026-09-23T09:20:00Z' : row.lastRetryableFailureAt,
      row.rejectionCode === undefined ? 'ownership_precondition_missing' : row.rejectionCode,
      row.rejectionClass === undefined ? 'REPAIRABLE' : row.rejectionClass,
      row.generation || 0,
    );
  }
  fs.writeFileSync(receiptPath, JSON.stringify(RECEIPT));
  return { dbPath, receiptPath, db, dir };
}

function runCli(args, expectStatus = 0) {
  try {
    return { status: 0, stdout: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    assert.equal(error.status, expectStatus, error.stderr && error.stderr.toString());
    return { status: error.status, stdout: error.stdout && error.stdout.toString(), stderr: error.stderr && error.stderr.toString() };
  }
}

test('dry run is the default and exact UUID selection leaves rows untouched', () => {
  const fixture = makeDb([{ eventUuid: 'event-1' }, { eventUuid: 'event-2' }]);
  try {
    const result = runCli([fixture.dbPath, 'event-1']);
    assert.match(result.stdout, /DRY RUN/);
    assert.match(result.stdout, /event-1/);
    assert.equal(fixture.db.prepare('SELECT rejected_at FROM sync_outbox WHERE event_uuid = ?').get('event-1').rejected_at, '2026-09-23T09:30:00Z');
  } finally { fixture.db.close(); }
});
test('execute records evidence and clears rejection, backoff, and retry state atomically', () => {
  const fixture = makeDb([{ eventUuid: 'event-1' }]);
  try {
    const result = runCli([fixture.dbPath, 'event-1', '--receipt', fixture.receiptPath, '--actor', 'operator-1', '--execute']);
    assert.match(result.stdout, /recovery committed/);
    const row = fixture.db.prepare('SELECT * FROM sync_outbox WHERE event_uuid = ?').get('event-1');
    assert.equal(row.rejected_at, null);
    assert.equal(row.rejection_reason, null);
    assert.equal(row.rejection_code, null);
    assert.equal(row.rejection_class, null);
    assert.equal(row.last_retryable_failure_at, null);
    assert.equal(row.retry_count, 0);
    assert.equal(row.recovery_generation, 1);
    const audit = fixture.db.prepare('SELECT * FROM sync_outbox_recovery_audit WHERE event_uuid = ?').get('event-1');
    assert.equal(audit.actor, 'operator-1');
    assert.match(audit.envelope_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(audit.receipt_json), RECEIPT);
  } finally { fixture.db.close(); }
});

test('delivered rows, second generation, and receipt mismatches refuse without mutation', () => {
  for (const row of [
    { eventUuid: 'delivered', deliveredAt: '2026-09-23T10:00:00Z' },
    { eventUuid: 'generation-1', generation: 1 },
    { eventUuid: 'bad-receipt', gateway: '0011223344556677' },
  ]) {
    const fixture = makeDb([row]);
    try {
      let receiptPath = fixture.receiptPath;
      if (row.eventUuid === 'bad-receipt') {
        fs.writeFileSync(receiptPath, JSON.stringify({ ...RECEIPT, cloudReplayRequest: { ...RECEIPT.cloudReplayRequest, eventUuid: 'bad-receipt' } }));
      }
      runCli([fixture.dbPath, row.eventUuid, '--receipt', receiptPath, '--execute'], 2);
      const state = fixture.db.prepare('SELECT recovery_generation, rejected_at FROM sync_outbox WHERE event_uuid = ?').get(row.eventUuid);
      assert.equal(state.recovery_generation, row.generation || 0);
      assert.equal(state.rejected_at, '2026-09-23T09:30:00Z');
      assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox_recovery_audit').get().n, 0);
    } finally { fixture.db.close(); }
  }
});

test('a multi-row transaction rolls back earlier evidence when a later UUID fails', () => {
  const fixture = makeDb([{ eventUuid: 'event-1' }, { eventUuid: 'event-2', rejectionCode: 'ownership_mismatch', rejectionClass: 'PERMANENT' }]);
  try {
    runCli([fixture.dbPath, 'event-1', 'event-2', '--receipt', fixture.receiptPath, '--execute'], 2);
    assert.equal(fixture.db.prepare('SELECT recovery_generation FROM sync_outbox WHERE event_uuid = ?').get('event-1').recovery_generation, 0);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox_recovery_audit').get().n, 0);
  } finally { fixture.db.close(); }
});

test('a scalar or malformed payload cannot be recovered', () => {
  for (const payloadJson of ['[]', 'null', '{bad']) {
    const fixture = makeDb([{ eventUuid: `bad-${payloadJson.length}`, payloadJson }]);
    try {
      const eventUuid = `bad-${payloadJson.length}`;
      runCli([fixture.dbPath, eventUuid, '--receipt', fixture.receiptPath, '--execute'], 2);
      assert.equal(fixture.db.prepare('SELECT recovery_generation FROM sync_outbox WHERE event_uuid = ?').get(eventUuid).recovery_generation, 0);
      assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox_recovery_audit').get().n, 0);
    } finally { fixture.db.close(); }
  }
});
