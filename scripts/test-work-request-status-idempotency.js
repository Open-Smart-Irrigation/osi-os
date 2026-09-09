#!/usr/bin/env node
// Behavioral guard for wave3-tail-fixes fix 3 (adapted from AgroLink
// ccb39eb2b, "fix(sync): make work-request-status-apply idempotent on
// command replay"). Executes the REAL shipped work-request-status-apply
// ("Apply Work Request Status") func as real JS, via vm, against a real
// seeded SQLite DB (node:sqlite), and proves:
//   - a first application updates improvement_requests.cloud_status and
//     writes an applied_commands dedup marker;
//   - a replay of the exact same commandId does NOT re-run the UPDATE (a
//     conflicting/stale second payload must not overwrite the applied
//     status) and instead rebuilds and returns the original terminal ACK
//     verbatim, using the stored applied_at rather than call-time now;
//   - a genuinely different commandId for the same request still applies
//     normally (positive control -- the guard is keyed on commandId, not
//     on the request row).
// Run: node --test scripts/test-work-request-status-idempotency.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const FLOW_PATHS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((rel) => path.join(REPO, rel));

function nodeById(flowPath, id) {
  return JSON.parse(fs.readFileSync(flowPath, 'utf8')).find((n) => n.id === id);
}

function seedDb() {
  const db = new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-request-status-')), 's.db'));
  db.exec(fs.readFileSync(SEED, 'utf8'));
  db.exec(`INSERT INTO users (id, username, password_hash, created_at, updated_at)
           VALUES (1, 'field-user', 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  return db;
}

function seedRequest(db, requestUuid) {
  db.prepare(`INSERT INTO improvement_requests
      (request_uuid, user_id, type, title, description, area, severity,
       consent_public, consent_diagnostics, diagnostics_json, gateway_device_eui,
       status_secret_hash, contact_email, submitted_at)
      VALUES (?, 1, 'bug', 'title', 'description', 'dashboard', 'annoying',
              1, 1, '{}', '0016C001F11715E2', 'sha256:fixture', 'field@example.test', '2026-01-01T00:00:00.000Z')`)
    .run(requestUuid);
}

function readRequest(db, requestUuid) {
  return db.prepare('SELECT cloud_status, cloud_reason, last_status_at FROM improvement_requests WHERE request_uuid = ?').get(requestUuid);
}

function readAppliedCommand(db, commandId) {
  return db.prepare('SELECT * FROM applied_commands WHERE command_id = ?').get(commandId);
}

// --- osiDb shim over a real node:sqlite DatabaseSync, matching the exact
// 3-arg (sql, params, callback) calling convention work-request-status-apply
// issues for both .run and .all. ---
function makeOsiDbShim(db) {
  class ShimDatabase {
    constructor(_filename) {}
    run(sql, params, callback) {
      try {
        const stmt = db.prepare(sql);
        const info = (params && params.length) ? stmt.run(...params) : stmt.run();
        if (typeof callback === 'function') callback.call({ changes: info.changes }, null);
      } catch (error) {
        if (typeof callback === 'function') callback(error);
        else throw error;
      }
    }
    all(sql, params, callback) {
      try {
        const stmt = db.prepare(sql);
        const rows = (params && params.length) ? stmt.all(...params) : stmt.all();
        if (typeof callback === 'function') callback(null, rows);
      } catch (error) {
        if (typeof callback === 'function') callback(error);
        else throw error;
      }
    }
    close(callback) {
      if (typeof callback === 'function') callback();
    }
  }
  return { Database: ShimDatabase };
}

async function runApplyFunc(func, payload, db, envValues) {
  const sandbox = {
    Buffer, console, require, process, setTimeout, clearTimeout,
    osiDb: makeOsiDbShim(db),
  };
  const script = new vm.Script(`(async function(msg,node,flow,env){${func}\n})`);
  const fn = script.runInNewContext(sandbox);
  const nodeApi = { error() {}, warn() {}, status() {} };
  const envApi = { get(key) { return (envValues || {})[key]; } };
  const flowApi = { get() { return undefined; }, set() {} };
  return fn({ payload }, nodeApi, flowApi, envApi);
}

const ENV = { DEVICE_EUI: '0016C001F11715E2' };

test('work-request-status-apply and applied_commands exist with the expected shape', () => {
  const node = nodeById(FLOW_PATHS[0], 'work-request-status-apply');
  assert.ok(node, 'work-request-status-apply node missing');
  assert.equal(node.type, 'function');
  assert.ok((node.libs || []).some((l) => l.var === 'osiDb' && l.module === 'osi-db-helper'), 'missing osiDb libs binding');
});

test('both profiles have byte-identical func for work-request-status-apply', () => {
  assert.equal(
    nodeById(FLOW_PATHS[0], 'work-request-status-apply').func,
    nodeById(FLOW_PATHS[1], 'work-request-status-apply').func
  );
});

test('first application: updates cloud_status and writes an applied_commands dedup marker', async () => {
  const db = seedDb();
  const requestUuid = '019ff001-1111-7222-8333-aaaaaaaaaaaa';
  seedRequest(db, requestUuid);
  const func = nodeById(FLOW_PATHS[0], 'work-request-status-apply').func;

  const ackMsg = await runApplyFunc(func, {
    commandId: 'cmd-1',
    request_id: requestUuid,
    status: 'approved',
    reason: 'looks good',
  }, db, ENV);

  const row = readRequest(db, requestUuid);
  assert.equal(row.cloud_status, 'approved', 'first application must update cloud_status');
  assert.equal(ackMsg.payload.result, 'APPLIED');
  assert.equal(ackMsg.payload.reason, 'work_request_status_applied');

  const applied = readAppliedCommand(db, 'cmd-1');
  assert.ok(applied, 'first application must write an applied_commands dedup marker');
  assert.equal(applied.command_type, 'WORK_REQUEST_STATUS');
  assert.equal(applied.result, 'APPLIED');
  db.close();
});

test('replay of the same commandId does NOT re-apply a conflicting status, and returns the original ACK verbatim', async () => {
  const db = seedDb();
  const requestUuid = '019ff001-1111-7222-8333-bbbbbbbbbbbb';
  seedRequest(db, requestUuid);
  const func = nodeById(FLOW_PATHS[0], 'work-request-status-apply').func;

  const firstAck = await runApplyFunc(func, {
    commandId: 'cmd-2',
    request_id: requestUuid,
    status: 'approved',
    reason: 'first pass',
  }, db, ENV);
  assert.equal(firstAck.payload.result, 'APPLIED');

  // Replay: same commandId, but a DIFFERENT (conflicting/stale) status. If
  // the idempotency guard is missing, this second UPDATE would silently
  // overwrite the already-applied 'approved' status with 'rejected'.
  const replayAck = await runApplyFunc(func, {
    commandId: 'cmd-2',
    request_id: requestUuid,
    status: 'rejected',
    reason: 'replayed-stale-payload',
  }, db, ENV);

  const row = readRequest(db, requestUuid);
  assert.equal(row.cloud_status, 'approved', 'a replayed commandId must never re-apply a different status');
  assert.equal(replayAck.payload.result, 'APPLIED', 'the replay must rebuild and return the original terminal ACK');
  assert.equal(replayAck.payload.reason, 'work_request_status_applied');
  db.close();
});

test('replay returns the ORIGINAL applied_at timestamp, not a fresh call-time now', async () => {
  const db = seedDb();
  const requestUuid = '019ff001-1111-7222-8333-cccccccccccc';
  seedRequest(db, requestUuid);
  const func = nodeById(FLOW_PATHS[0], 'work-request-status-apply').func;

  await runApplyFunc(func, { commandId: 'cmd-3', request_id: requestUuid, status: 'approved' }, db, ENV);
  const applied = readAppliedCommand(db, 'cmd-3');
  const originalAppliedAt = applied.applied_at;

  // Force real wall-clock separation so a fresh `now` would visibly differ
  // from the stored applied_at if the replay path (incorrectly) used it.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const replayAck = await runApplyFunc(func, { commandId: 'cmd-3', request_id: requestUuid, status: 'rejected' }, db, ENV);
  assert.equal(replayAck.payload.timestamp, originalAppliedAt, 'replay must use the stored applied_at, not a fresh now()');
  db.close();
});

test('a genuinely different commandId for the same request still applies normally (positive control)', async () => {
  const db = seedDb();
  const requestUuid = '019ff001-1111-7222-8333-dddddddddddd';
  seedRequest(db, requestUuid);
  const func = nodeById(FLOW_PATHS[0], 'work-request-status-apply').func;

  await runApplyFunc(func, { commandId: 'cmd-4a', request_id: requestUuid, status: 'approved' }, db, ENV);
  const secondAck = await runApplyFunc(func, { commandId: 'cmd-4b', request_id: requestUuid, status: 'rejected' }, db, ENV);

  const row = readRequest(db, requestUuid);
  assert.equal(row.cloud_status, 'rejected', 'a genuinely new commandId must apply its own status normally');
  assert.equal(secondAck.payload.result, 'APPLIED');
  assert.ok(readAppliedCommand(db, 'cmd-4a'), 'first commandId must have its own dedup marker');
  assert.ok(readAppliedCommand(db, 'cmd-4b'), 'second commandId must have its own dedup marker');
  db.close();
});

test('a request_not_found response is not written to the applied_commands ledger (no false dedup marker)', async () => {
  const db = seedDb();
  const func = nodeById(FLOW_PATHS[0], 'work-request-status-apply').func;
  const ack = await runApplyFunc(func, { commandId: 'cmd-5', request_id: 'no-such-request', status: 'approved' }, db, ENV);
  assert.equal(ack.payload.result, 'REJECTED_PERMANENT');
  assert.equal(ack.payload.reason, 'request_not_found');
  assert.equal(readAppliedCommand(db, 'cmd-5'), undefined, 'a request_not_found ack must not create an applied_commands row');
  db.close();
});
