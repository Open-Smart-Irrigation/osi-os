#!/usr/bin/env node
'use strict';
// Bovey cloud full-parity Task P4-E1: the sync-bootstrap-build / sync-force-build flows.json
// nodes both gained a `valve_actuations` bootstrap array (operator ruling: history DOES
// backfill). Extracts the REAL query + shaping block out of the node source (rather than
// duplicating it here, which would let the two drift silently) and runs it against a real
// sqlite fixture via node:sqlite, asserting: shape matches VALVE_ACTUATION_ARCHIVED's own
// payload, the 200-row cap, ORDER BY commanded_at DESC, and the terminal-state filter (active
// PENDING_OBSERVATION/OBSERVED_RUNNING rows never appear).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const PROFILES = ['bcm27xx_bcm2712', 'bcm27xx_bcm2709'];
const NODE_IDS = ['sync-bootstrap-build', 'sync-force-build'];
const EUI = '0016C001F1000001';

function extractBlock(func) {
  const startMarker = 'const valveActuationRows = await q(';
  const start = func.indexOf(startMarker);
  if (start < 0) throw new Error('valveActuationRows query not found in node func');
  const endMarker = '}));';
  const end = func.indexOf(endMarker, start);
  if (end < 0) throw new Error('end of valveActuations map not found');
  return func.slice(start, end + endMarker.length);
}

function loadBlock(profile, nodeId) {
  const flowsPath = path.resolve(__dirname, `../conf/full_raspberrypi_${profile}/files/usr/share/flows.json`);
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const node = flows.find((n) => n.id === nodeId);
  if (!node) throw new Error(`${nodeId} not found in ${flowsPath}`);
  return extractBlock(node.func);
}

// Runs the extracted block against a real sqlite db, returning the resulting `valveActuations`
// array. The block only references `q` (an async SELECT runner) and produces `valveActuations`
// as its last statement's binding -- both source nodes bind it identically, so this harness
// needs nothing else from their surrounding closures.
async function runBlock(block, raw) {
  const q = (sql) => Promise.resolve(raw.prepare(sql).all());
  const runner = new Function('q', `return (async () => {\n${block}\n  return valveActuations;\n})();`);
  return runner(q);
}

async function tempDb() {
  const os = require('node:os');
  const src = path.resolve(__dirname, '../database/farming.db');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-boot-')), 'farming.db');
  fs.copyFileSync(src, dbPath);
  const raw = new DatabaseSync(dbPath);
  raw.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'t','x',datetime('now'))");
  raw.exec(`INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('${EUI}','Valve A','STREGA_VALVE',1,datetime('now'),datetime('now'))`);
  return raw;
}

function insertExpectation(raw, row) {
  raw.prepare(
    'INSERT INTO valve_actuation_expectations(expectation_id, device_eui, zone_id, commanded_at, commanded_duration_seconds, expected_close_at, observed_open_at, observed_close_at, volume_source, reconciliation_state, cancel_reason, trigger, created_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    row.expectation_id, row.device_eui || EUI, row.zone_id || null, row.commanded_at, row.commanded_duration_seconds || 900,
    row.expected_close_at, row.observed_open_at || null, row.observed_close_at || null, row.volume_source || 'unknown',
    row.reconciliation_state, row.cancel_reason || null, row.trigger || null, row.commanded_at
  );
}

async function main() {
  for (const profile of PROFILES) {
    for (const nodeId of NODE_IDS) {
      const block = loadBlock(profile, nodeId);

      await test(`[${profile}/${nodeId}] terminal states are included, active states are excluded`, async () => {
        const raw = await tempDb();
        insertExpectation(raw, { expectation_id: 'e-complete', reconciliation_state: 'OBSERVED_COMPLETE', commanded_at: '2026-08-20T10:00:00.000Z', expected_close_at: '2026-08-20T10:15:00.000Z', observed_open_at: '2026-08-20T10:00:05.000Z', observed_close_at: '2026-08-20T10:15:03.000Z' });
        insertExpectation(raw, { expectation_id: 'e-cancelled', reconciliation_state: 'CANCELLED', commanded_at: '2026-08-21T10:00:00.000Z', expected_close_at: '2026-08-21T10:15:00.000Z', cancel_reason: 'operator_cancel' });
        insertExpectation(raw, { expectation_id: 'e-open-timeout', reconciliation_state: 'STALE_NO_OBSERVATION', commanded_at: '2026-08-22T10:00:00.000Z', expected_close_at: '2026-08-22T10:15:00.000Z' });
        insertExpectation(raw, { expectation_id: 'e-close-timeout', reconciliation_state: 'STALE_OPEN_OBSERVED', commanded_at: '2026-08-23T10:00:00.000Z', expected_close_at: '2026-08-23T10:15:00.000Z', observed_open_at: '2026-08-23T10:00:05.000Z' });
        insertExpectation(raw, { expectation_id: 'e-pending', reconciliation_state: 'PENDING_OBSERVATION', commanded_at: '2026-08-24T10:00:00.000Z', expected_close_at: '2026-08-24T10:15:00.000Z' });
        insertExpectation(raw, { expectation_id: 'e-running', reconciliation_state: 'OBSERVED_RUNNING', commanded_at: '2026-08-24T11:00:00.000Z', expected_close_at: '2026-08-24T11:15:00.000Z', observed_open_at: '2026-08-24T11:00:05.000Z' });

        const rows = await runBlock(block, raw);
        const ids = rows.map((r) => r.expectation_id).sort();
        assert.deepEqual(ids, ['e-cancelled', 'e-close-timeout', 'e-complete', 'e-open-timeout'], 'active PENDING_OBSERVATION/OBSERVED_RUNNING rows must never appear');
        raw.close();
      });

      await test(`[${profile}/${nodeId}] ordered by commanded_at DESC, capped at 200`, async () => {
        const raw = await tempDb();
        for (let i = 0; i < 205; i += 1) {
          const at = new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString();
          insertExpectation(raw, { expectation_id: 'e-' + String(i).padStart(4, '0'), reconciliation_state: 'CANCELLED', commanded_at: at, expected_close_at: at });
        }
        const rows = await runBlock(block, raw);
        assert.equal(rows.length, 200, 'must cap at 200 rows');
        assert.equal(rows[0].expectation_id, 'e-0204', 'newest commanded_at first');
        assert.equal(rows[199].expectation_id, 'e-0005', 'the 5 oldest rows must be dropped by the cap');
        raw.close();
      });

      await test(`[${profile}/${nodeId}] shape matches VALVE_ACTUATION_ARCHIVED's own payload (field-for-field), zone_id resolved to zone_uuid, archived_at fallback chain`, async () => {
        const raw = await tempDb();
        raw.exec("INSERT INTO irrigation_zones(name, user_id, created_at, updated_at) VALUES ('Z1',1,datetime('now'),datetime('now'))");
        const zone = raw.prepare('SELECT id, zone_uuid FROM irrigation_zones LIMIT 1').get();
        insertExpectation(raw, {
          expectation_id: 'e1', zone_id: zone.id, reconciliation_state: 'OBSERVED_COMPLETE', trigger: 'on_valve_schedule',
          commanded_at: '2026-08-20T10:00:00.000Z', commanded_duration_seconds: 900, expected_close_at: '2026-08-20T10:15:00.000Z',
          observed_open_at: '2026-08-20T10:00:05.000Z', observed_close_at: '2026-08-20T10:15:03.000Z', volume_source: 'estimated_duration_flow_rate',
        });
        // A terminal row that never observed a close at all -- archived_at must fall back to
        // expected_close_at (the same COALESCE order runtime.js's buildActuationPayload uses).
        insertExpectation(raw, {
          expectation_id: 'e2', reconciliation_state: 'STALE_NO_OBSERVATION',
          commanded_at: '2026-08-21T10:00:00.000Z', expected_close_at: '2026-08-21T10:15:00.000Z',
        });

        const rows = await runBlock(block, raw);
        const byId = Object.fromEntries(rows.map((r) => [r.expectation_id, r]));

        assert.deepEqual(byId.e1, {
          contract_version: 1,
          expectation_id: 'e1',
          device_eui: EUI,
          zone_uuid: zone.zone_uuid,
          status: 'COMPLETED',
          trigger: 'on_valve_schedule',
          commanded_at: '2026-08-20T10:00:00.000Z',
          observed_open_at: '2026-08-20T10:00:05.000Z',
          observed_close_at: '2026-08-20T10:15:03.000Z',
          expected_close_at: '2026-08-20T10:15:00.000Z',
          duration_seconds: 900,
          estimated_gross_liters: null,
          volume_source: 'estimated_duration_flow_rate',
          cancel_reason: null,
          command_result_detail: null,
          archived_at: '2026-08-20T10:15:03.000Z',
        });
        assert.equal(byId.e2.status, 'OPEN_TIMEOUT');
        assert.equal(byId.e2.zone_uuid, null);
        assert.equal(byId.e2.archived_at, '2026-08-21T10:15:00.000Z', 'no observed_close_at -- falls back to expected_close_at');
        raw.close();
      });
    }
  }
}

main();
