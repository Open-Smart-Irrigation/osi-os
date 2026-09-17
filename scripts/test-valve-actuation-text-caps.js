#!/usr/bin/env node
'use strict';
// F96: applied_commands.result_detail (SQLite TEXT, unbounded) and
// valve_actuation_expectations.cancel_reason (same, unbounded) are shipped VERBATIM as
// ValveActuation.command_result_detail/cancel_reason by the "Build Cloud Bootstrap"
// (sync-bootstrap-build) / "Run Force Sync" (sync-force-build) bootstrap query and the
// "Build Edge Event Batch" (sync-outbox-build) / "Run Force Sync" outbox delivery mapping
// -- and the cloud's mirror columns (org.osi.server.valve.ValveActuation.commandResultDetail/
// cancelReason) are varchar(255). Silvan reproduced a 319-char result_detail for a local
// OPEN_FOR_DURATION command (run 3 R1 #11; bovey.cloud 04:10:20Z
// DataIntegrityViolationException: value too long for type character varying(255) at
// EdgeSyncService.upsertValveActuation:1332), which 500s the gateway's entire cloud
// bootstrap until the row ages out of the 200-row window.
//
// Fixed at the payload boundary (this file's subject): sanitizeSyncRow()/
// normalizeOutboxPayload() gained a shared capFreeTextFields() pass over cancel_reason/
// command_result_detail (maxLength 255 per docs/contracts/sync-schema/resources.schema.json,
// truncated with a trailing "…[truncated]" marker rather than dropped), and the bootstrap's
// valve_actuations backfill array -- which previously bypassed sanitizeSyncRow entirely --
// is now routed through it. The writer-side half of the fix (osi-command-ledger's
// queueCommandAck, osi-valve-control/cancel.js's normalizeReason) is covered by
// conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
// and .../osi-valve-control/cancel.test.js.
//
// Structure mirrors scripts/test-valve-schedule-timestamp-wire-format.js (F81's own payload-
// boundary regression test): Layer 1 extracts and unit-tests the truncation helpers verbatim
// out of all three nodes; Layer 2 extracts and unit-tests normalizeOutboxPayload's
// VALVE_ACTUATION scoping; Layer 3 runs the REAL, unmodified "Build Edge Event Batch" node
// function (vm.Script against a real sqlite fixture with the real migrations applied) against
// an oversized-value row already queued in sync_outbox, proving the fix self-heals a
// bug-shaped row exactly like F81's did. sync-bootstrap-build/sync-force-build's heavier
// bootstrap payload (identity/installation/journal advertisement) is not run end-to-end here
// (Layer 1's direct extraction plus the "wired, not dead code" regex check below cover them);
// see test-journal-bootstrap.js for why a full bootstrap fixture is a much larger lift.
//
// Run: node --test scripts/test-valve-actuation-text-caps.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../lib/osi-migrate');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const PROFILES = ['bcm27xx_bcm2712', 'bcm27xx_bcm2709'];
const DEVICE_EUI = 'A84041CAFECAFE31';
const GATEWAY_EUI = '0016C001F11715E2';
const MAX_LENGTH = 255;
const TRUNCATION_MARKER = '…[truncated]';
// Matches the magnitude of Silvan's reproduced 319-char result_detail (F96).
const LONG_VALUE = 'downlink timeout: gateway did not acknowledge queue flush within budget; retrying '.repeat(4);

function flowsPath(profile) {
  return path.join(REPO, `conf/full_raspberrypi_${profile}/files/usr/share/flows.json`);
}
function nodeById(profile, id) {
  const p = flowsPath(profile);
  const node = JSON.parse(fs.readFileSync(p, 'utf8')).find((n) => n.id === id);
  assert.ok(node, `${id} not found in ${p}`);
  return node;
}

// --- Layer 1: extract truncateWithMarker/capFreeTextFields verbatim and unit-test them ---
// Present (as its own copy) in sync-bootstrap-build, sync-outbox-build, and sync-force-build.
function extractFreeTextHelpers(func) {
  const start = func.indexOf('const TRUNCATION_MARKER');
  assert.notEqual(start, -1, 'TRUNCATION_MARKER block not found');
  const sanitizeIdx = func.indexOf('\nfunction sanitizeSyncRow', start);
  const normalizeIdx = func.indexOf('\nfunction normalizeOutboxPayload', start);
  const candidates = [sanitizeIdx, normalizeIdx].filter((i) => i !== -1);
  assert.ok(candidates.length, 'neither sanitizeSyncRow nor normalizeOutboxPayload follows the free-text helpers');
  const end = Math.min(...candidates);
  return func.slice(start, end);
}
function loadFreeTextHelpers(func) {
  return new Function(extractFreeTextHelpers(func) + '\nreturn { truncateWithMarker, capFreeTextFields, FREE_TEXT_FIELD_LIMITS, TRUNCATION_MARKER };')();
}

for (const profile of PROFILES) {
  for (const nodeId of ['sync-bootstrap-build', 'sync-outbox-build', 'sync-force-build']) {
    test(`[${profile}/${nodeId}] truncateWithMarker caps a 319-char value to 255 chars with a marker (F96)`, () => {
      const { truncateWithMarker } = loadFreeTextHelpers(nodeById(profile, nodeId).func);
      const input = 'x'.repeat(319);
      const result = truncateWithMarker(input, MAX_LENGTH);
      assert.equal(result.length, MAX_LENGTH, 'result must be exactly the cap, never over it');
      assert.ok(result.endsWith(TRUNCATION_MARKER), 'truncation must be marked, never silent');
      assert.ok(input.startsWith(result.slice(0, result.length - TRUNCATION_MARKER.length)), 'must be a prefix truncation, not garbled');
    });

    test(`[${profile}/${nodeId}] truncateWithMarker leaves a value at or under the cap untouched`, () => {
      const { truncateWithMarker } = loadFreeTextHelpers(nodeById(profile, nodeId).func);
      const exact = 'x'.repeat(MAX_LENGTH);
      assert.equal(truncateWithMarker(exact, MAX_LENGTH), exact);
      assert.equal(truncateWithMarker('short', MAX_LENGTH), 'short');
      assert.equal(truncateWithMarker(null, MAX_LENGTH), null, 'null passes through (not a string)');
      assert.equal(truncateWithMarker(undefined, MAX_LENGTH), undefined, 'undefined passes through (not a string)');
    });

    test(`[${profile}/${nodeId}] capFreeTextFields caps cancel_reason and command_result_detail, leaves other fields alone`, () => {
      const { capFreeTextFields, FREE_TEXT_FIELD_LIMITS } = loadFreeTextHelpers(nodeById(profile, nodeId).func);
      assert.deepEqual(FREE_TEXT_FIELD_LIMITS, { cancel_reason: 255, command_result_detail: 255 });
      const row = {
        expectation_id: 'e1',
        device_eui: DEVICE_EUI,
        cancel_reason: LONG_VALUE,
        command_result_detail: LONG_VALUE,
        status: 'COMPLETED',
      };
      assert.ok(LONG_VALUE.length > MAX_LENGTH, 'fixture must actually exceed the cloud column width');
      const capped = capFreeTextFields(row);
      assert.equal(capped.cancel_reason.length, MAX_LENGTH);
      assert.equal(capped.command_result_detail.length, MAX_LENGTH);
      assert.ok(capped.cancel_reason.endsWith(TRUNCATION_MARKER));
      assert.ok(capped.command_result_detail.endsWith(TRUNCATION_MARKER));
      assert.equal(capped.expectation_id, 'e1', 'unrelated fields must pass through unchanged');
      assert.equal(capped.status, 'COMPLETED', 'unrelated fields must pass through unchanged');
    });

    test(`[${profile}/${nodeId}] capFreeTextFields leaves short/null cancel_reason and command_result_detail alone`, () => {
      const { capFreeTextFields } = loadFreeTextHelpers(nodeById(profile, nodeId).func);
      const row = { cancel_reason: null, command_result_detail: 'short error' };
      const capped = capFreeTextFields(row);
      assert.equal(capped.cancel_reason, null);
      assert.equal(capped.command_result_detail, 'short error');
    });

    test(`[${profile}/${nodeId}] capFreeTextFields tolerates a non-object input (defensive, matches sanitizeSyncRow's row||{} convention)`, () => {
      const { capFreeTextFields } = loadFreeTextHelpers(nodeById(profile, nodeId).func);
      assert.equal(capFreeTextFields(null), null);
      assert.equal(capFreeTextFields(undefined), undefined);
    });
  }
}

// --- Layer 1b: sanitizeSyncRow (bootstrap/force-build) actually calls capFreeTextFields, ---
// --- and the bootstrap's valve_actuations array is routed through it (wired, not dead code) --
function extractFunctionBody(func, name) {
  const idx = func.indexOf('function ' + name + '(');
  assert.notEqual(idx, -1, name + ' not found');
  let i = func.indexOf('{', idx);
  let depth = 0;
  for (; i < func.length; i += 1) {
    if (func[i] === '{') depth += 1;
    else if (func[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return func.slice(idx, i);
}

for (const profile of PROFILES) {
  for (const nodeId of ['sync-bootstrap-build', 'sync-force-build']) {
    test(`[${profile}/${nodeId}] sanitizeSyncRow (F96: extended for the payload boundary) calls capFreeTextFields`, () => {
      const body = extractFunctionBody(nodeById(profile, nodeId).func, 'sanitizeSyncRow');
      assert.match(body, /return capFreeTextFields\(copy\);/, 'sanitizeSyncRow must route through capFreeTextFields, not return the bare copy');
    });

    test(`[${profile}/${nodeId}] the bootstrap valve_actuations backfill array is routed through sanitizeSyncRow (previously bypassed it entirely)`, () => {
      assert.match(nodeById(profile, nodeId).func, /valve_actuations:\s*valveActuations\.map\(sanitizeSyncRow\),/,
        `${nodeId} must map valveActuations through sanitizeSyncRow before shipping`);
    });
  }

  test(`[${profile}/sync-outbox-build] normalizeOutboxPayload calls capFreeTextFields for VALVE_ACTUATION`, () => {
    const body = extractFunctionBody(nodeById(profile, 'sync-outbox-build').func, 'normalizeOutboxPayload');
    assert.match(body, /if \(type === 'VALVE_ACTUATION'\) \{\s*capFreeTextFields\(payload\);\s*\}/,
      'normalizeOutboxPayload must cap VALVE_ACTUATION payloads via capFreeTextFields');
  });
}

// --- Layer 2: extract normalizeOutboxPayload verbatim and unit-test its VALVE_ACTUATION ---
// --- scoping (never touches other aggregate types; leaves short values untouched). --------
function extractNormalizeOutboxPayload(func) {
  return extractFunctionBody(func, 'normalizeOutboxPayload');
}
function loadOutboxHelpers(func) {
  const src = extractFreeTextHelpers(func) + '\n' + extractNormalizeOutboxPayload(func);
  return new Function(src + '\nreturn { normalizeOutboxPayload };')();
}

for (const profile of PROFILES) {
  for (const nodeId of ['sync-outbox-build', 'sync-force-build']) {
    test(`[${profile}/${nodeId}] normalizeOutboxPayload caps an oversized VALVE_ACTUATION cancel_reason/command_result_detail on the wire (F96)`, () => {
      const { normalizeOutboxPayload } = loadOutboxHelpers(nodeById(profile, nodeId).func);
      const fixed = normalizeOutboxPayload('VALVE_ACTUATION', {
        expectation_id: 'e1',
        cancel_reason: LONG_VALUE,
        command_result_detail: LONG_VALUE,
      });
      assert.ok(fixed.cancel_reason.length <= MAX_LENGTH);
      assert.ok(fixed.command_result_detail.length <= MAX_LENGTH);
      assert.ok(fixed.cancel_reason.endsWith(TRUNCATION_MARKER));
      assert.ok(fixed.command_result_detail.endsWith(TRUNCATION_MARKER));
      assert.equal(fixed.expectation_id, 'e1', 'other fields pass through unchanged');
    });

    test(`[${profile}/${nodeId}] normalizeOutboxPayload leaves a short VALVE_ACTUATION cancel_reason/command_result_detail untouched`, () => {
      const { normalizeOutboxPayload } = loadOutboxHelpers(nodeById(profile, nodeId).func);
      const untouched = normalizeOutboxPayload('VALVE_ACTUATION', {
        expectation_id: 'e1', cancel_reason: null, command_result_detail: 'short',
      });
      assert.equal(untouched.cancel_reason, null);
      assert.equal(untouched.command_result_detail, 'short');
    });

    test(`[${profile}/${nodeId}] normalizeOutboxPayload never touches non-VALVE_ACTUATION payloads (scoping precision)`, () => {
      const { normalizeOutboxPayload } = loadOutboxHelpers(nodeById(profile, nodeId).func);
      const other = normalizeOutboxPayload('VALVE_SETTINGS', { device_eui: 'x', cancel_reason: LONG_VALUE });
      assert.equal(other.cancel_reason, LONG_VALUE, 'VALVE_SETTINGS has no cancel_reason field at all; must not be mangled by a scoping bug');
    });

    test(`[${profile}/${nodeId}] the delivery mapping actually calls normalizeOutboxPayload (wired, not dead code)`, () => {
      const func = nodeById(profile, nodeId).func;
      assert.match(func, /payload:\s*normalizeOutboxPayload\(r\.aggregate_type,\s*parseJsonValue\(r\.payload_json,\s*r\.event_uuid\)\)/,
        `${nodeId} delivery mapping must route the parsed payload through normalizeOutboxPayload`);
    });
  }
}

// --- Layer 3: full end-to-end -- real, unmodified "Build Edge Event Batch" node function ---
// --- against a real sqlite fixture with an already-queued oversized VALVE_ACTUATION event. -
function makeOsiDbShim(db) {
  class ShimDatabase {
    constructor(_filename) {}
    all(sql, params, callback) {
      try { callback(null, db.prepare(sql).all(...(params || []))); }
      catch (error) { callback(error); }
    }
    run(sql, params, callback) {
      try { db.prepare(sql).run(...(params || [])); callback(null); }
      catch (error) { callback(error); }
    }
    close(callback) { callback(); }
  }
  return { Database: ShimDatabase };
}

async function runSyncOutboxBuildFunc(func, db, envValues) {
  const flowState = new Map();
  const sandbox = { Buffer, console, require, process, setTimeout, clearTimeout, osiDb: makeOsiDbShim(db) };
  const script = new vm.Script(`(async function(msg,node,flow,env,global){${func}\n})`);
  const fn = script.runInNewContext(sandbox);
  const msg = {};
  const nodeApi = { error() {}, warn() {}, status() {} };
  const flowApi = { get: (k) => flowState.get(k), set: (k, v) => flowState.set(k, v) };
  const envApi = { get: (k) => (Object.prototype.hasOwnProperty.call(envValues, k) ? envValues[k] : undefined) };
  const globalApi = { get: (k) => (k === 'fs' ? { existsSync: () => false } : undefined) };
  const result = await fn(msg, nodeApi, flowApi, envApi, globalApi);
  return result;
}

async function buildOversizedActuationFixture(dbPath) {
  const runner = cliRunner(dbPath);
  await bootstrapFresh(runner, { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });
  await runner.exec(`
    INSERT INTO users(id, username, password_hash, created_at, user_uuid, server_url, server_sync_token)
      VALUES(1, 'local', 'x', '2026-09-17T00:00:00.000Z', 'user-1', 'https://cloud.example.test', 'tok-1');
    INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, gateway_device_eui)
      VALUES('${DEVICE_EUI}', 'Valve 1', 'STREGA_VALVE', 1, '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z', '${GATEWAY_EUI}');
    INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at)
      VALUES('cloud', 1, '${GATEWAY_EUI}', '2026-09-17T00:00:00.000Z');
    INSERT INTO applied_commands(command_id, device_eui, command_type, applied_at, result, result_detail)
      VALUES('cmd-1', '${DEVICE_EUI}', 'OPEN_FOR_DURATION', '2026-09-17T00:00:00.000Z', 'FAILED_RETRYABLE', 'x');
    INSERT INTO valve_actuation_expectations(
      expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds,
      expected_close_at, volume_source, reconciliation_state, cancel_reason, created_at
    ) VALUES(
      'exp-1', '${DEVICE_EUI}', 'cmd-1', '2026-09-17T00:00:00.000Z', 900,
      '2026-09-17T00:15:00.000Z', 'unknown', 'STALE_NO_OBSERVATION', '${LONG_VALUE.replace(/'/g, "''")}',
      '2026-09-17T00:00:00.000Z'
    );
  `);
  // Simulate a row already queued with the F96 bug baked in -- exactly the "self-heals
  // queued rows" shape F81's own fix produced -- rather than requiring osi-valve-control/
  // runtime.js's emitActuationArchived to be exercised for real here (covered end-to-end by
  // conf/.../osi-valve-control/runtime.test.js instead). This proves sync-outbox-build's
  // OUTBOX DELIVERY path (not just newly-emitted rows) self-heals a pre-existing oversized
  // value on its way out, matching F81's own precedent scope.
  const payload = JSON.stringify({
    contract_version: 1,
    expectation_id: 'exp-1',
    device_eui: DEVICE_EUI,
    zone_uuid: null,
    status: 'COMMAND_FAILED',
    trigger: null,
    commanded_at: '2026-09-17T00:00:00.000Z',
    observed_open_at: null,
    observed_close_at: null,
    expected_close_at: '2026-09-17T00:15:00.000Z',
    duration_seconds: 900,
    estimated_gross_liters: null,
    volume_source: 'unknown',
    cancel_reason: LONG_VALUE,
    command_result_detail: LONG_VALUE,
    archived_at: '2026-09-17T00:15:00.000Z',
  });
  await runner.exec(
    `INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui)
     VALUES('11111111-1111-4111-8111-111111111111', 'VALVE_ACTUATION', 'exp-1', 'VALVE_ACTUATION_ARCHIVED', '${payload.replace(/'/g, "''")}', 0, '2026-09-17T00:15:00.000Z', '${GATEWAY_EUI}');`
  );
}

for (const profile of PROFILES) {
  test(`[${profile}] end-to-end: a real queued VALVE_ACTUATION_ARCHIVED event ships cancel_reason/command_result_detail at <= 255 chars, not raw unbounded text (F96)`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valve-actuation-text-caps-'));
    const dbPath = path.join(dir, 'r.db');
    try {
      await buildOversizedActuationFixture(dbPath);

      // Sanity: the row on disk must still carry the bug-shaped oversized value (this fix
      // does not touch how the row is queued, only what ships from it).
      const preCheck = new DatabaseSync(dbPath);
      const queuedRow = preCheck.prepare(
        "SELECT payload_json FROM sync_outbox WHERE aggregate_type='VALVE_ACTUATION' ORDER BY occurred_at DESC LIMIT 1"
      ).get();
      preCheck.close();
      assert.ok(queuedRow, 'a VALVE_ACTUATION outbox row must be queued');
      const queuedPayload = JSON.parse(queuedRow.payload_json);
      assert.ok(queuedPayload.command_result_detail.length > MAX_LENGTH,
        'sanity: the row on disk must still carry the raw, oversized value (this fix does not touch how the row is queued)');

      const db = new DatabaseSync(dbPath);
      const func = nodeById(profile, 'sync-outbox-build').func;
      const envValues = {
        DEVICE_EUI: GATEWAY_EUI,
        DEVICE_EUI_SOURCE: 'chirpstack',
        DEVICE_EUI_CONFIDENCE: 'high',
        DEVICE_EUI_LAST_VERIFIED_AT: '2026-09-17T00:00:00.000Z',
        LINK_GATEWAY_DEVICE_EUI: '',
      };
      const msg = await runSyncOutboxBuildFunc(func, db, envValues);
      db.close();

      assert.ok(msg, 'sync-outbox-build must return a message (a pending VALVE_ACTUATION event exists)');
      assert.ok(Array.isArray(msg.payload && msg.payload.events), 'msg.payload.events must be an array');
      const event = msg.payload.events.find((e) => e.aggregateType === 'VALVE_ACTUATION');
      assert.ok(event, 'a VALVE_ACTUATION event must be present in the batch');
      assert.ok(event.payload.command_result_detail.length <= MAX_LENGTH,
        'the wire payload command_result_detail must never exceed the cloud varchar(255) mirror column -- this is what broke the cloud bootstrap (F96)');
      assert.ok(event.payload.cancel_reason.length <= MAX_LENGTH,
        'the wire payload cancel_reason must never exceed the cloud varchar(255) mirror column');
      assert.ok(event.payload.command_result_detail.endsWith(TRUNCATION_MARKER), 'truncation must be marked, never silent');
      assert.ok(event.payload.cancel_reason.endsWith(TRUNCATION_MARKER), 'truncation must be marked, never silent');
      assert.equal(event.payload.expectation_id, 'exp-1', 'other fields must pass through unchanged');
      assert.equal(event.payload.status, 'COMMAND_FAILED', 'other fields must pass through unchanged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[${profile}] end-to-end: a normal (short) VALVE_ACTUATION event ships its cancel_reason/command_result_detail unchanged`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valve-actuation-text-caps-short-'));
    const dbPath = path.join(dir, 'r.db');
    try {
      const runner = cliRunner(dbPath);
      await bootstrapFresh(runner, { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });
      await runner.exec(`
        INSERT INTO users(id, username, password_hash, created_at, user_uuid, server_url, server_sync_token)
          VALUES(1, 'local', 'x', '2026-09-17T00:00:00.000Z', 'user-1', 'https://cloud.example.test', 'tok-1');
        INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, gateway_device_eui)
          VALUES('${DEVICE_EUI}', 'Valve 1', 'STREGA_VALVE', 1, '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z', '${GATEWAY_EUI}');
        INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at)
          VALUES('cloud', 1, '${GATEWAY_EUI}', '2026-09-17T00:00:00.000Z');
      `);
      const payload = JSON.stringify({
        contract_version: 1, expectation_id: 'exp-2', device_eui: DEVICE_EUI, zone_uuid: null,
        status: 'COMPLETED', trigger: null, commanded_at: '2026-09-17T00:00:00.000Z',
        observed_open_at: '2026-09-17T00:00:05.000Z', observed_close_at: '2026-09-17T00:15:00.000Z',
        expected_close_at: '2026-09-17T00:15:00.000Z', duration_seconds: 900,
        estimated_gross_liters: 12.5, volume_source: 'measured_flow_meter',
        cancel_reason: null, command_result_detail: null, archived_at: '2026-09-17T00:15:00.000Z',
      });
      await runner.exec(
        `INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui)
         VALUES('22222222-2222-4222-8222-222222222222', 'VALVE_ACTUATION', 'exp-2', 'VALVE_ACTUATION_ARCHIVED', '${payload.replace(/'/g, "''")}', 0, '2026-09-17T00:15:00.000Z', '${GATEWAY_EUI}');`
      );

      const db = new DatabaseSync(dbPath);
      const func = nodeById(profile, 'sync-outbox-build').func;
      const envValues = {
        DEVICE_EUI: GATEWAY_EUI, DEVICE_EUI_SOURCE: 'chirpstack', DEVICE_EUI_CONFIDENCE: 'high',
        DEVICE_EUI_LAST_VERIFIED_AT: '2026-09-17T00:00:00.000Z', LINK_GATEWAY_DEVICE_EUI: '',
      };
      const msg = await runSyncOutboxBuildFunc(func, db, envValues);
      db.close();

      const event = msg.payload.events.find((e) => e.aggregateType === 'VALVE_ACTUATION');
      assert.ok(event, 'the INSERT itself must have queued a VALVE_ACTUATION event');
      assert.equal(event.payload.cancel_reason, null, 'a normal completed actuation has no cancel_reason');
      assert.equal(event.payload.command_result_detail, null, 'a normal completed actuation has no command_result_detail');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
