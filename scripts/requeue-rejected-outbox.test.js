'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, 'requeue-rejected-outbox.js');

// Minimal sync_outbox schema — column list copied verbatim from
// database/seed-blank.sql so this test exercises the real shape.
const SYNC_OUTBOX_SCHEMA = `
CREATE TABLE sync_outbox (
  event_uuid                TEXT PRIMARY KEY,
  aggregate_type            TEXT NOT NULL,
  aggregate_key             TEXT NOT NULL,
  op                        TEXT NOT NULL,
  payload_json              TEXT NOT NULL,
  sync_version              INTEGER NOT NULL DEFAULT 0,
  occurred_at               TEXT NOT NULL,
  delivered_at              TEXT,
  retry_count               INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui        TEXT,
  rejected_at               TEXT,
  rejection_reason          TEXT,
  last_retryable_failure_at TEXT
);
`;

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-'));
  const dbPath = path.join(dir, 'farming.db');
  const db = new DatabaseSync(dbPath);
  db.exec(SYNC_OUTBOX_SCHEMA);
  return { dbPath, db };
}

function insertRow(db, overrides) {
  const row = {
    event_uuid: 'evt-1',
    aggregate_type: 'DEVICE_DATA',
    aggregate_key: 'k1',
    op: 'INSERT',
    payload_json: '{}',
    occurred_at: '2026-08-01T00:00:00.000Z',
    delivered_at: null,
    gateway_device_eui: null,
    rejected_at: null,
    rejection_reason: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO sync_outbox
       (event_uuid, aggregate_type, aggregate_key, op, payload_json, occurred_at,
        delivered_at, gateway_device_eui, rejected_at, rejection_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.event_uuid, row.aggregate_type, row.aggregate_key, row.op, row.payload_json,
    row.occurred_at, row.delivered_at, row.gateway_device_eui, row.rejected_at, row.rejection_reason
  );
}

function runCli(args) {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

test('refuses a nonexistent DB path (does not create/mutate an empty file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-missing-'));
  const missing = path.join(dir, 'nope.db');
  let status = 0;
  try {
    execFileSync('node', [SCRIPT, missing], { encoding: 'utf8' });
  } catch (e) {
    status = e.status;
  }
  assert.strictEqual(status, 2, 'must exit 2 for a missing DB');
  assert.strictEqual(fs.existsSync(missing), false, 'must NOT create the file');
});

test('dry run (default) prints the matched summary but mutates nothing', () => {
  const { dbPath, db } = makeDb();
  try {
    insertRow(db, { event_uuid: 'rejected-1', rejected_at: '2026-08-01T00:00:00.000Z', rejection_reason: 'owner_unknown' });
    insertRow(db, { event_uuid: 'delivered-1', delivered_at: '2026-08-01T00:00:01.000Z', rejected_at: null });

    const out = runCli([dbPath]);
    assert.match(out, /DRY RUN/);
    assert.match(out, /1 row\(s\) match/);

    const row = db.prepare('SELECT rejected_at, rejection_reason FROM sync_outbox WHERE event_uuid = ?').get('rejected-1');
    assert.strictEqual(row.rejected_at, '2026-08-01T00:00:00.000Z', 'dry run must not clear rejected_at');
    assert.strictEqual(row.rejection_reason, 'owner_unknown', 'dry run must not clear rejection_reason');
  } finally {
    db.close();
  }
});

test('--execute clears rejected_at/rejection_reason only on matched rows', () => {
  const { dbPath, db } = makeDb();
  try {
    insertRow(db, {
      event_uuid: 'rejected-device',
      aggregate_type: 'DEVICE_DATA',
      occurred_at: '2026-08-01T00:00:00.000Z',
      rejected_at: '2026-08-01T00:00:00.000Z',
      rejection_reason: 'owner_unknown',
    });
    insertRow(db, {
      event_uuid: 'rejected-zone',
      aggregate_type: 'ZONE',
      occurred_at: '2026-08-01T00:00:00.000Z',
      rejected_at: '2026-08-01T00:00:00.000Z',
      rejection_reason: 'owner_unknown',
    });

    const out = runCli([dbPath, '--aggregate-type', 'DEVICE_DATA', '--execute']);
    assert.match(out, /cleared rejected_at\/rejection_reason on 1 row\(s\)/);

    const cleared = db.prepare('SELECT rejected_at, rejection_reason FROM sync_outbox WHERE event_uuid = ?').get('rejected-device');
    assert.strictEqual(cleared.rejected_at, null, '--execute must clear the matched row');
    assert.strictEqual(cleared.rejection_reason, null);

    const untouched = db.prepare('SELECT rejected_at, rejection_reason FROM sync_outbox WHERE event_uuid = ?').get('rejected-zone');
    assert.strictEqual(untouched.rejected_at, '2026-08-01T00:00:00.000Z', 'a non-matching row must be left alone');
    assert.strictEqual(untouched.rejection_reason, 'owner_unknown');
  } finally {
    db.close();
  }
});

test('--rejected-before/--rejected-after filter the window', () => {
  const { dbPath, db } = makeDb();
  try {
    insertRow(db, { event_uuid: 'old', occurred_at: '2026-07-01T00:00:00.000Z', rejected_at: '2026-07-01T00:00:00.000Z' });
    insertRow(db, { event_uuid: 'new', occurred_at: '2026-08-01T00:00:00.000Z', rejected_at: '2026-08-01T00:00:00.000Z' });

    const beforeOut = runCli([dbPath, '--rejected-before', '2026-07-15T00:00:00.000Z']);
    assert.match(beforeOut, /1 row\(s\) match/);

    const afterOut = runCli([dbPath, '--rejected-after', '2026-07-15T00:00:00.000Z']);
    assert.match(afterOut, /1 row\(s\) match/);

    runCli([dbPath, '--rejected-before', '2026-07-15T00:00:00.000Z', '--execute']);
    const oldRow = db.prepare('SELECT rejected_at FROM sync_outbox WHERE event_uuid = ?').get('old');
    const newRow = db.prepare('SELECT rejected_at FROM sync_outbox WHERE event_uuid = ?').get('new');
    assert.strictEqual(oldRow.rejected_at, null, 'the old row (before the cutoff) must be requeued');
    assert.strictEqual(newRow.rejected_at, '2026-08-01T00:00:00.000Z', 'the new row (after the cutoff) must be untouched');
  } finally {
    db.close();
  }
});

test('--limit caps the matched set to the oldest occurred_at rows', () => {
  const { dbPath, db } = makeDb();
  try {
    insertRow(db, { event_uuid: 'oldest', occurred_at: '2026-08-01T00:00:00.000Z', rejected_at: '2026-08-01T00:00:00.000Z' });
    insertRow(db, { event_uuid: 'middle', occurred_at: '2026-08-02T00:00:00.000Z', rejected_at: '2026-08-02T00:00:00.000Z' });
    insertRow(db, { event_uuid: 'newest', occurred_at: '2026-08-03T00:00:00.000Z', rejected_at: '2026-08-03T00:00:00.000Z' });

    runCli([dbPath, '--limit', '1', '--execute']);

    const oldest = db.prepare('SELECT rejected_at FROM sync_outbox WHERE event_uuid = ?').get('oldest');
    const middle = db.prepare('SELECT rejected_at FROM sync_outbox WHERE event_uuid = ?').get('middle');
    const newest = db.prepare('SELECT rejected_at FROM sync_outbox WHERE event_uuid = ?').get('newest');

    assert.strictEqual(oldest.rejected_at, null, '--limit 1 must requeue the oldest occurred_at row first');
    assert.strictEqual(middle.rejected_at, '2026-08-02T00:00:00.000Z');
    assert.strictEqual(newest.rejected_at, '2026-08-03T00:00:00.000Z');
  } finally {
    db.close();
  }
});

test('rejects an invalid --rejected-before timestamp as a usage error', () => {
  const { dbPath, db } = makeDb();
  try {
    let status = 0;
    try {
      execFileSync('node', [SCRIPT, dbPath, '--rejected-before', 'not-a-date'], { encoding: 'utf8' });
    } catch (e) {
      status = e.status;
    }
    assert.strictEqual(status, 2);
  } finally {
    db.close();
  }
});
