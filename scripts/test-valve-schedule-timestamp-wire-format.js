#!/usr/bin/env node
'use strict';
// F81 regression: osi-valve-control/store.js writes valve_schedules.created_at/
// updated_at/deleted_at with SQLite's own datetime('now') default
// ('YYYY-MM-DD HH:MM:SS', space-separated, no 'Z'). The 0024 migration's
// trg_sync_valve_schedules_outbox_ai/_au triggers carry deleted_at into
// sync_outbox.payload_json UNCONVERTED (unlike VALVE_SETTINGS' updated_at,
// which the 0025 trigger already reformats via strftime), and the cloud's
// EdgeSyncService.parseNullableInstant (strict java.time.Instant.parse) throws
// on the space-separated form -- the first schedule a customer deletes breaks
// that gateway's entire cloud bootstrap (bovey.cloud backend log,
// 2026-09-17T02:11:15Z).
//
// Fix landed at the payload boundary, not the trigger/column default (no
// migration): the "Build Cloud Bootstrap" (sync-bootstrap-build) / "Run Force
// Sync" (sync-force-build) nodes' shared normalizeIsoTimestamp() gained a
// branch for the space-separated form, and the "Build Edge Event Batch"
// (sync-outbox-build) / "Run Force Sync" (sync-force-build) nodes now run
// every VALVE_SCHEDULE outbox event's payload through a new
// normalizeOutboxPayload() wrapper immediately before it goes on the wire --
// fixing both future trigger-written rows and ones already queued in
// sync_outbox with the bug baked in, with the trigger and column default left
// untouched.
//
// The wire format is not merely "ISO with a Z": docs/contracts/sync-schema/
// resources.schema.json pins ValveSchedule.deleted_at to
// NullableCanonicalUtcTimestamp, whose pattern requires EXACTLY 3
// fractional-second digits (^...T..:..:..\.[0-9]{3}Z$) -- matching
// ValveSettings.updated_at's own already-correct strftime('%Y-%m-%dT%H:%M:%fZ',
// ...) convention. A bare '...27Z' (no milliseconds) would satisfy Java's
// lenient Instant.parse but would NOT satisfy this repo's own pinned contract
// pattern, so the fix appends '.000' for the (never-fractional) datetime('now')
// input, and this guard asserts against the actual schema pattern, not just a
// human-eyeballed string.
//
// This guard runs the REAL migration-installed 0024 trigger (via cliRunner,
// same mechanism verify-seed-replay.js uses) to produce a genuinely
// bug-shaped queued sync_outbox row, then executes the REAL, UNMODIFIED
// "Build Edge Event Batch" node function (vm.Script against a real sqlite
// fixture, mirroring test-outbox-retry-backoff.js's osiDb shim pattern) and
// asserts the wire payload's deleted_at is exactly millisecond-precision
// ISO-8601 UTC ('.000Z'), conformant with NullableCanonicalUtcTimestamp.
//
// Run: node --test scripts/test-valve-schedule-timestamp-wire-format.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../lib/osi-migrate');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const PROFILES = ['bcm27xx_bcm2712', 'bcm27xx_bcm2709'];
const DEVICE_EUI = 'A84041CAFECAFE30';
const GATEWAY_EUI = '0016C001F11715E2';
// The exact reproduction value from F81 (bovey.cloud backend log / Silvan
// read-only SQL): SQLite's datetime('now') default, space-separated, no 'Z'.
const RAW_SQLITE_TS = '2026-09-17 00:42:27';
// docs/contracts/sync-schema/resources.schema.json's NullableCanonicalUtcTimestamp
// pattern requires exactly 3 fractional-second digits -- not a bare 'Z'.
const EXPECTED_ISO = '2026-09-17T00:42:27.000Z';
const CANONICAL_UTC_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

function flowsPath(profile) {
  return path.join(REPO, `conf/full_raspberrypi_${profile}/files/usr/share/flows.json`);
}
function nodeById(profile, id) {
  const p = flowsPath(profile);
  const node = JSON.parse(fs.readFileSync(p, 'utf8')).find((n) => n.id === id);
  assert.ok(node, `${id} not found in ${p}`);
  return node;
}

// --- Layer 1: extract normalizeIsoTimestamp verbatim and unit-test it -------
// Present (as its own copy) in sync-bootstrap-build, sync-force-build, and
// (newly, for this fix) sync-outbox-build.
function extractNormalizeIsoTimestamp(func) {
  const start = func.indexOf('function normalizeIsoTimestamp(value) {');
  assert.notEqual(start, -1, 'normalizeIsoTimestamp not found');
  const end = func.indexOf('\n}', start) + 2;
  return func.slice(start, end);
}
function loadNormalizeIsoTimestamp(func) {
  return new Function(extractNormalizeIsoTimestamp(func) + '\nreturn normalizeIsoTimestamp;')();
}

for (const profile of PROFILES) {
  for (const nodeId of ['sync-bootstrap-build', 'sync-force-build', 'sync-outbox-build']) {
    test(`[${profile}/${nodeId}] normalizeIsoTimestamp converts the F81 SQLite space-separated form to millisecond-precision ISO Z`, () => {
      const normalizeIsoTimestamp = loadNormalizeIsoTimestamp(nodeById(profile, nodeId).func);
      const result = normalizeIsoTimestamp(RAW_SQLITE_TS);
      assert.equal(result, EXPECTED_ISO,
        `datetime('now')-shaped '${RAW_SQLITE_TS}' must become '${EXPECTED_ISO}'`);
      assert.match(result, CANONICAL_UTC_TIMESTAMP_PATTERN,
        'result must satisfy resources.schema.json NullableCanonicalUtcTimestamp exactly (3 fractional digits), not just "look like" ISO-Z');
    });

    test(`[${profile}/${nodeId}] normalizeIsoTimestamp is idempotent / null-safe / leaves already-correct values alone`, () => {
      const normalizeIsoTimestamp = loadNormalizeIsoTimestamp(nodeById(profile, nodeId).func);
      assert.equal(normalizeIsoTimestamp(EXPECTED_ISO), EXPECTED_ISO, 'already-Z value must be unchanged (idempotent)');
      assert.equal(normalizeIsoTimestamp('2026-09-17T00:42:27.123Z'), '2026-09-17T00:42:27.123Z', 'already-correct fractional+Z value untouched');
      assert.equal(normalizeIsoTimestamp('2026-09-17T00:42:27.123'), '2026-09-17T00:42:27.123Z', 'pre-existing no-Z-but-T branch still appends Z');
      assert.equal(normalizeIsoTimestamp(null), null, 'null stays null');
      assert.equal(normalizeIsoTimestamp(''), null, 'empty string normalizes to null');
      assert.equal(normalizeIsoTimestamp(undefined), null, 'undefined normalizes to null');
    });
  }
}

// --- Layer 2: extract normalizeOutboxPayload verbatim and unit-test its ----
// --- scoping (VALVE_SCHEDULE only; never touches other aggregate types). ---
function extractNormalizeOutboxPayload(func) {
  const start = func.indexOf('function normalizeOutboxPayload(');
  assert.notEqual(start, -1, 'normalizeOutboxPayload not found');
  const end = func.indexOf('\n}', start) + 2;
  return func.slice(start, end);
}
function loadOutboxHelpers(func) {
  const src = extractNormalizeIsoTimestamp(func) + '\n' + extractNormalizeOutboxPayload(func);
  return new Function(src + '\nreturn { normalizeIsoTimestamp, normalizeOutboxPayload };')();
}

for (const profile of PROFILES) {
  for (const nodeId of ['sync-outbox-build', 'sync-force-build']) {
    test(`[${profile}/${nodeId}] normalizeOutboxPayload fixes VALVE_SCHEDULE.deleted_at on the wire`, () => {
      const { normalizeOutboxPayload } = loadOutboxHelpers(nodeById(profile, nodeId).func);
      const fixed = normalizeOutboxPayload('VALVE_SCHEDULE', { schedule_uuid: 'x', deleted_at: RAW_SQLITE_TS });
      assert.equal(fixed.deleted_at, EXPECTED_ISO);
      assert.equal(fixed.schedule_uuid, 'x', 'other fields pass through unchanged');
    });

    test(`[${profile}/${nodeId}] normalizeOutboxPayload leaves a null deleted_at (an active, undeleted schedule) as null`, () => {
      const { normalizeOutboxPayload } = loadOutboxHelpers(nodeById(profile, nodeId).func);
      const untouched = normalizeOutboxPayload('VALVE_SCHEDULE', { schedule_uuid: 'x', deleted_at: null });
      assert.equal(untouched.deleted_at, null);
    });

    test(`[${profile}/${nodeId}] normalizeOutboxPayload never touches non-VALVE_SCHEDULE payloads (scoping precision)`, () => {
      const { normalizeOutboxPayload } = loadOutboxHelpers(nodeById(profile, nodeId).func);
      const other = normalizeOutboxPayload('VALVE_SETTINGS', { device_eui: 'x', updated_at: RAW_SQLITE_TS });
      assert.equal(other.updated_at, RAW_SQLITE_TS, 'VALVE_SETTINGS already reformats updated_at via its own 0025 trigger strftime -- must not be double-processed here');
    });

    test(`[${profile}/${nodeId}] the delivery mapping actually calls normalizeOutboxPayload (wired, not dead code)`, () => {
      const func = nodeById(profile, nodeId).func;
      assert.match(func, /payload:\s*normalizeOutboxPayload\(r\.aggregate_type,\s*parseJsonValue\(r\.payload_json,\s*r\.event_uuid\)\)/,
        `${nodeId} delivery mapping must route the parsed payload through normalizeOutboxPayload`);
    });
  }
}

// --- Layer 3: full end-to-end -- real 0024 trigger + real, unmodified ------
// --- "Build Edge Event Batch" node function against a real sqlite fixture. -
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

async function buildLinkedValveScheduleFixture(dbPath, deletedAtRaw) {
  const runner = cliRunner(dbPath);
  await bootstrapFresh(runner, { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });
  await runner.exec(`
    INSERT INTO users(id, username, password_hash, created_at, user_uuid, server_url, server_sync_token)
      VALUES(1, 'local', 'x', '2026-09-17T00:00:00.000Z', 'user-1', 'https://cloud.example.test', 'tok-1');
    INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, gateway_device_eui)
      VALUES('${DEVICE_EUI}', 'Valve 1', 'STREGA_VALVE', 1, '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z', '${GATEWAY_EUI}');
    INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at)
      VALUES('cloud', 1, '${GATEWAY_EUI}', '2026-09-17T00:00:00.000Z');
    INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, fire_at, duration_minutes, timezone, enabled, once_state)
      VALUES('33333333-3333-4333-8333-333333333333', '${DEVICE_EUI}', 'WEEKLY', 'Morning', 3, '06:05', NULL, 15, 'Europe/Zurich', 1, NULL);
  `);
  // Isolate the deletion event: the INSERT above already queued its own
  // VALVE_SCHEDULE_UPSERTED row (deleted_at: null), which the trigger-firing
  // UPDATE below does not replace, only append to (0024's design: every write
  // is its own outbox row). Clearing it first, matching
  // test-valve-schedule-sync-triggers.js's own established pattern, means
  // exactly one VALVE_SCHEDULE row -- the deletion -- is queued for the
  // sync-outbox-build run below to pick up.
  await runner.exec('DELETE FROM sync_outbox;');
  // The production write path (osi-valve-control/store.js softDeleteSchedule):
  // UPDATE ... SET deleted_at=datetime('now'), sync_version=..., updated_at=datetime('now').
  // Using a literal in place of datetime('now') pins a deterministic value while
  // keeping the exact same space-separated shape the real column write produces.
  await runner.exec(
    `UPDATE valve_schedules SET deleted_at='${deletedAtRaw}', sync_version=COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE schedule_uuid='33333333-3333-4333-8333-333333333333';`
  );
}

for (const profile of PROFILES) {
  test(`[${profile}] end-to-end: a real 0024-trigger-emitted VALVE_SCHEDULE event ships deleted_at as ISO Z, not raw SQLite text`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valve-sched-wire-'));
    const dbPath = path.join(dir, 'r.db');
    try {
      await buildLinkedValveScheduleFixture(dbPath, RAW_SQLITE_TS);

      // Prove the trigger really did write the bug-shaped raw value (so this
      // test is exercising the real production defect, not a synthetic one).
      const preCheck = new DatabaseSync(dbPath);
      const queuedRow = preCheck.prepare(
        "SELECT payload_json FROM sync_outbox WHERE aggregate_type='VALVE_SCHEDULE' ORDER BY occurred_at DESC LIMIT 1"
      ).get();
      preCheck.close();
      assert.ok(queuedRow, 'the 0024 _au trigger must have queued a VALVE_SCHEDULE outbox row');
      const queuedPayload = JSON.parse(queuedRow.payload_json);
      assert.equal(queuedPayload.deleted_at, RAW_SQLITE_TS,
        'sanity: the trigger payload_json on disk must still carry the raw, unconverted SQLite timestamp (this fix does not touch the trigger)');

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

      assert.ok(msg, 'sync-outbox-build must return a message (a pending VALVE_SCHEDULE event exists)');
      assert.ok(Array.isArray(msg.payload && msg.payload.events), 'msg.payload.events must be an array');
      const event = msg.payload.events.find((e) => e.aggregateType === 'VALVE_SCHEDULE');
      assert.ok(event, 'a VALVE_SCHEDULE event must be present in the batch');
      assert.equal(event.payload.deleted_at, EXPECTED_ISO,
        'the wire payload deleted_at must be millisecond-precision ISO-8601 UTC, matching every other synced timestamp -- this is what broke the cloud bootstrap (F81)');
      assert.match(event.payload.deleted_at, CANONICAL_UTC_TIMESTAMP_PATTERN,
        'must satisfy resources.schema.json NullableCanonicalUtcTimestamp exactly');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[${profile}] end-to-end: an active (never-deleted) schedule's null deleted_at ships as null, not a stringified value`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valve-sched-wire-active-'));
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
        INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, fire_at, duration_minutes, timezone, enabled, once_state)
          VALUES('44444444-4444-4444-8444-444444444444', '${DEVICE_EUI}', 'WEEKLY', 'Morning', 3, '06:05', NULL, 15, 'Europe/Zurich', 1, NULL);
      `);

      const db = new DatabaseSync(dbPath);
      const func = nodeById(profile, 'sync-outbox-build').func;
      const envValues = {
        DEVICE_EUI: GATEWAY_EUI, DEVICE_EUI_SOURCE: 'chirpstack', DEVICE_EUI_CONFIDENCE: 'high',
        DEVICE_EUI_LAST_VERIFIED_AT: '2026-09-17T00:00:00.000Z', LINK_GATEWAY_DEVICE_EUI: '',
      };
      const msg = await runSyncOutboxBuildFunc(func, db, envValues);
      db.close();

      const event = msg.payload.events.find((e) => e.aggregateType === 'VALVE_SCHEDULE');
      assert.ok(event, 'the INSERT itself must have queued a VALVE_SCHEDULE event');
      assert.equal(event.payload.deleted_at, null, 'an active schedule must ship deleted_at: null, not a coerced string');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
