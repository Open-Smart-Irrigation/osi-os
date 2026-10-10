'use strict';
// Zone-day rain quality on the sync paths (docs/contracts/rainfall/zone-day-projection.md):
// the ZONE_ENVIRONMENT_APPENDED event payload (insert and update triggers,
// migration 0073) carries rain_coverage, rain_selected_deveui,
// rain_policy_version, rain_quality_reasons (a JSON array) and
// rain_received_mm; a legacy row (no rain_policy_version) carries the keys
// with null values.
// Run: node --test scripts/test-zone-env-rain-quality-sync.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { seedTestDb } = require('./lib/flow-node-harness');

const GATEWAY = '0016C001F1000001';
const GAUGE = 'A840410000000001';
const QUALITY_KEYS = ['rain_coverage', 'rain_selected_deveui', 'rain_policy_version', 'rain_quality_reasons', 'rain_received_mm'];

function linkedDb() {
  const db = seedTestDb();
  db.prepare('INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES (?, ?, ?, ?)')
    .run('cloud', 1, GATEWAY, '2026-10-01T00:00:00.000Z');
  return db;
}

function zoneEvents(db, key = 'z-1|2026-10-08') {
  return db.prepare("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE_ENVIRONMENT' AND aggregate_key = ? ORDER BY rowid")
    .all(key).map((row) => ({ op: row.op, syncVersion: row.sync_version, payload: JSON.parse(row.payload_json) }));
}

function insertProjected(db, overrides = {}) {
  const row = {
    zone_id: 1, date: '2026-10-08', rainfall_mm: null, flow_liters: 0, rain_source: 'aquascope_lorain',
    computed_at: '2026-10-08T12:00:00.000Z', sync_version: 1, rain_coverage: 'partial', rain_selected_deveui: GAUGE,
    rain_policy_version: 1, rain_quality_reasons: '["frame_gap"]', rain_received_mm: 2.5, ...overrides,
  };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO zone_daily_environment (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((key) => row[key]));
}

test('insert: the event payload carries the five quality fields, reasons as a JSON array', () => {
  const db = linkedDb();
  insertProjected(db);
  const events = zoneEvents(db);
  assert.equal(events.length, 1);
  const { payload } = events[0];
  assert.equal(events[0].op, 'ZONE_ENVIRONMENT_APPENDED');
  assert.equal(payload.contract_version, 1);
  assert.equal(payload.rain_coverage, 'partial');
  assert.equal(payload.rain_selected_deveui, GAUGE);
  assert.equal(payload.rain_policy_version, 1);
  assert.deepEqual(payload.rain_quality_reasons, ['frame_gap'], 'an array, never a string holding one');
  assert.equal(payload.rain_received_mm, 2.5);
  assert.equal(payload.rainfall_mm, null, 'a present null: the day is not certified');
  assert.ok(Object.prototype.hasOwnProperty.call(payload, 'rainfall_mm'));
  assert.equal(payload.sync_version, 1);
  assert.equal(payload.zone_uuid, 'z-1');
});

test('insert: an empty reason list is an empty array', () => {
  const db = linkedDb();
  insertProjected(db, { rainfall_mm: 4.5, rain_coverage: 'complete', rain_quality_reasons: '[]', rain_received_mm: 4.5 });
  const { payload } = zoneEvents(db)[0];
  assert.deepEqual(payload.rain_quality_reasons, []);
  assert.equal(payload.rainfall_mm, 4.5);
  assert.equal(payload.rain_coverage, 'complete');
});

test('update with a bumped sync_version: one new event with the new values', () => {
  const db = linkedDb();
  insertProjected(db);
  db.prepare(`UPDATE zone_daily_environment SET rainfall_mm = 4.5, rain_coverage = 'complete', rain_quality_reasons = '[]',
    rain_received_mm = 4.5, computed_at = '2026-10-09T00:10:00.000Z', sync_version = sync_version + 1 WHERE zone_id = 1 AND date = '2026-10-08'`).run();
  const events = zoneEvents(db);
  assert.equal(events.length, 2);
  const [first, second] = events;
  assert.ok(second.syncVersion > first.syncVersion);
  assert.equal(second.payload.sync_version, 2);
  assert.equal(second.payload.rainfall_mm, 4.5);
  assert.equal(second.payload.rain_coverage, 'complete');
  assert.deepEqual(second.payload.rain_quality_reasons, []);
  assert.equal(second.payload.rain_received_mm, 4.5);
  assert.equal(second.payload.rain_selected_deveui, GAUGE);
  assert.equal(second.payload.rain_policy_version, 1);
});

test('update without a version bump: no event', () => {
  const db = linkedDb();
  insertProjected(db);
  db.prepare("UPDATE zone_daily_environment SET rain_quality_reasons = '[\"frame_gap\",\"ongoing\"]' WHERE zone_id = 1 AND date = '2026-10-08'").run();
  assert.equal(zoneEvents(db).length, 1);
});

test('a legacy row (five NULLs) carries the five keys with null values', () => {
  const db = linkedDb();
  db.prepare("INSERT INTO zone_daily_environment (zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at, sync_version) VALUES (1, '2026-10-08', 3.2, 0, 'aquascope_lorain', '2026-10-08T12:00:00.000Z', 1)").run();
  const { payload } = zoneEvents(db)[0];
  for (const key of QUALITY_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `${key} present`);
    assert.equal(payload[key], null, `${key} null`);
  }
  assert.equal(payload.rainfall_mm, 3.2, 'the legacy amount travels as before');
});

test('a row without a rain policy version is never sent with quality fields set', () => {
  const db = linkedDb();
  insertProjected(db, { rain_policy_version: null });
  db.prepare("UPDATE zone_daily_environment SET sync_version = 2 WHERE zone_id = 1 AND date = '2026-10-08'").run();
  const events = zoneEvents(db);
  assert.equal(events.length, 2);
  for (const { payload } of events) {
    for (const key of QUALITY_KEYS) assert.equal(payload[key], null, `${key} null on a row without a policy version`);
  }
});

test('stored reasons that are not a JSON array never fail the write and travel as null', () => {
  const db = linkedDb();
  insertProjected(db, { rain_quality_reasons: 'frame_gap' });
  insertProjected(db, { date: '2026-10-09', rain_quality_reasons: '{"a":1}' });
  assert.equal(zoneEvents(db)[0].payload.rain_quality_reasons, null);
  assert.equal(zoneEvents(db, 'z-1|2026-10-09')[0].payload.rain_quality_reasons, null);
  assert.equal(zoneEvents(db)[0].payload.rain_coverage, 'partial', 'the rest of the row still travels');
});

test('an unlinked gateway emits nothing', () => {
  const db = seedTestDb();
  insertProjected(db);
  assert.equal(zoneEvents(db).length, 0);
});

test('migration 0073 creates the trigger bodies of sync-trigger-source.json byte for byte (the boot node recreates the same)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'database/migrations/ordered/0073__zone_env_rain_quality_sync.sql'), 'utf8');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'scripts/sync-trigger-source.json'), 'utf8'));
  const db = linkedDb();
  db.exec(migration);
  for (const name of ['trg_dp_zone_env_outbox_ai', 'trg_dp_zone_env_outbox_au']) {
    const entry = source.triggers.find((t) => t.name === name);
    assert.ok(migration.includes(`DROP TRIGGER IF EXISTS ${name};\n${entry.sql}\n`), `${name}: migration CREATE equals the canonical entry`);
    const stored = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name).sql;
    assert.equal(`${stored};`, entry.sql, `${name}: sqlite_master holds the canonical body`);
  }
  insertProjected(db);
  assert.deepEqual(zoneEvents(db)[0].payload.rain_quality_reasons, ['frame_gap']);
});

// ---------------------------------------------------------------------------
// History rows and snapshots (Task 2). History rows are `SELECT zde.*` and travel
// whole; the history hash v1 input stays the six columns (contract "History rows").
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { facadeDb } = require('./lib/flow-node-harness');
const { hashRow } = require('./lib/history-hash-v1');

const ROOT = path.resolve(__dirname, '..');
const NODE_RED = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const historySync = require(path.join(NODE_RED, 'osi-history-sync-helper/index.js'));
const R = require(path.join(NODE_RED, 'osi-rain/index.js'));
const HASH_COLUMNS = ['zone_uuid', 'date', 'rainfall_mm', 'flow_liters', 'rain_source', 'computed_at'];

function historyRows(db, phase = 'live') {
  const sql = historySync.batchQuery('zone_daily_environment', phase);
  const params = historySync.batchQueryParams('zone_daily_environment', phase, null, null, 100);
  return db.prepare(sql).all(...params).map((row) => ({ ...row }));
}
function v1HashOfSixColumns(row) {
  const key = historySync.historyKey('zone_daily_environment', GATEWAY, row);
  const sourceRow = Object.fromEntries(HASH_COLUMNS.map((name) => [name, row[name]]));
  return hashRow({ tableName: 'zone_daily_environment', historyKey: key, sourceRow });
}

test('history: a zone_daily_environment row carries sync_version and the five fields; its hash is the v1 hash of the six columns', () => {
  const db = linkedDb();
  insertProjected(db, { sync_version: 3 });
  const [row] = historyRows(db);
  const prepared = historySync.prepareRow('zone_daily_environment', GATEWAY, row);
  assert.equal(prepared.quarantineReason, null);
  assert.equal(prepared.historyKey, 'ZONE_ENVIRONMENT|z-1|2026-10-08');
  assert.equal(prepared.payload.sync_version, 3);
  assert.equal(prepared.payload.rain_coverage, 'partial');
  assert.equal(prepared.payload.rain_selected_deveui, GAUGE);
  assert.equal(prepared.payload.rain_policy_version, 1);
  assert.equal(prepared.payload.rain_quality_reasons, '["frame_gap"]', 'history rows carry the stored JSON text');
  assert.equal(prepared.payload.rain_received_mm, 2.5);
  assert.equal(prepared.payloadHash, v1HashOfSixColumns(row));
  // The quality fields and sync_version are not hash input.
  const stripped = { ...row, rain_coverage: null, rain_selected_deveui: null, rain_policy_version: null,
    rain_quality_reasons: null, rain_received_mm: null, sync_version: 0 };
  assert.equal(historySync.hashHistoryRow('zone_daily_environment', prepared.historyKey, stripped), prepared.payloadHash);
  // The segment path reads the same row.
  const segment = historySync.segmentQuery('zone_daily_environment', 'z-1|2026-10-08');
  const [segmentRow] = db.prepare(segment.sql).all(...segment.params);
  assert.equal(historySync.prepareRow('zone_daily_environment', GATEWAY, { ...segmentRow }).payloadHash, prepared.payloadHash);
});

test('history: a legacy row carries the five fields as null', () => {
  const db = linkedDb();
  db.prepare("INSERT INTO zone_daily_environment (zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at, sync_version) VALUES (1, '2026-10-08', 3.2, 0, 'aquascope_lorain', '2026-10-08T12:00:00.000Z', 1)").run();
  const prepared = historySync.prepareRow('zone_daily_environment', GATEWAY, historyRows(db)[0]);
  for (const key of QUALITY_KEYS) assert.equal(prepared.payload[key], null, `${key} null`);
  assert.equal(prepared.payload.rainfall_mm, 3.2);
});

// LoRain frames through the osi-rain writer (the R-ZONE end-to-end setup).
const CODEC = path.join(NODE_RED, 'codecs/aquascope_lorain_decoder.js');
const decodeUplink = (() => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODEC, 'utf8'), sandbox, { filename: CODEC });
  return sandbox.decodeUplink;
})();
const PINNED = [{ fPort: 2, buildDate: '241015' }];
const NOW = Date.parse('2026-10-10T03:00:00.000Z');
const JOIN_HEX = '0a0003ad7703050001040403840402001006030000060100b8068100001221000a';
const rainHex = (tips) => '06030000060100b8068100' + tips.toString(16).padStart(2, '0') + '1221000a';
const tx = (db, fn) => facadeDb(db).transaction(fn);
let frameSeq = 0;
async function loRain(db, { fCnt, time, hex, devAddr = '01000001' }) {
  frameSeq += 1;
  const bytes = Buffer.from(hex, 'hex');
  return tx(db, (t) => R.ingestLoRainUplink(t, {
    deveui: GAUGE, eventId: '00000000-0000-4000-b000-' + String(frameSeq).padStart(12, '0'), devAddr, fCnt, time, fPort: 2,
    data: bytes.toString('base64'), object: decodeUplink({ fPort: 2, bytes }).data,
  }, { nowMs: NOW, pinnedBuilds: PINNED }));
}
// A promoted chain over 2026-10-08 (UTC): join 2 h before, a frame every 4 h,
// 10 tips (5 mm) at noon, and the frame at midnight that closes the day.
function dayChain() {
  const start = Date.parse('2026-10-08T00:00:00.000Z');
  const end = Date.parse('2026-10-09T00:00:00.000Z');
  const times = [start - 2 * 3600000];
  for (let ms = start; ms < end; ms += 4 * 3600000) times.push(ms);
  times.push(end);
  return times.map((ms, i) => ({ fCnt: i, time: new Date(ms).toISOString(), hex: i === 0 ? JOIN_HEX : rainHex(i === 4 ? 10 : 0) }));
}
function seedGauge(db) {
  db.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES (?, 'Gauge', 'AQUASCOPE_LORAIN', 2, 1, '2026-01-01', '2026-01-01')").run(GAUGE);
}
const zoneRow = (db) => ({ ...db.prepare("SELECT * FROM zone_daily_environment WHERE zone_id = 1 AND date = '2026-10-08'").get() });

test('history: a coverage-only change through recomputeZoneDay writes a new computed_at, so the history hash changes', async () => {
  const db = linkedDb();
  seedGauge(db);
  for (const frame of dayChain().filter((f) => f.fCnt !== 3)) await loRain(db, frame);
  const before = zoneRow(db);
  assert.equal(before.rain_coverage, 'partial');
  // An invalid zone timezone: the day is computed in UTC as before, the amounts
  // and the source stay, only coverage and reasons change.
  db.prepare("UPDATE irrigation_zones SET timezone = 'Mars/Olympus' WHERE id = 1").run();
  const out = await tx(db, (t) => R.recomputeZoneDay(t, 1, '2026-10-08', { trigger: 'reassessed', nowMs: NOW }));
  assert.equal(out.written, 'updated');
  const after = zoneRow(db);
  assert.equal(after.rain_coverage, 'unknown');
  assert.ok(JSON.parse(after.rain_quality_reasons).includes('timezone_invalid'));
  for (const name of ['rainfall_mm', 'flow_liters', 'rain_source', 'rain_received_mm']) assert.equal(after[name], before[name], `${name} unchanged`);
  assert.ok(after.computed_at > before.computed_at, 'a new computed_at with the projected change');
  assert.equal(after.sync_version, before.sync_version + 1);
  const hashOf = (row) => historySync.prepareRow('zone_daily_environment', GATEWAY, { ...row, zone_uuid: 'z-1' }).payloadHash;
  assert.notEqual(hashOf(after), hashOf(before), 'the cloud would otherwise drop the row as DUPLICATE');
});

// Bootstrap and force-sync snapshots, through the shipped function bodies against
// one real SQLite database (the shape of test-watermark-calibration-bootstrap.js).
const FLOWS = JSON.parse(fs.readFileSync(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));
const byId = Object.fromEntries(FLOWS.map((node) => [node.id, node]));
const installation = require(path.join(NODE_RED, 'osi-installation-helper/index.js'));
const rejection = require(path.join(NODE_RED, 'osi-rejection-recovery/index.js'));

function isoDay(offsetDays) { return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10); }

function snapshotDb() {
  const db = seedTestDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET role = 'admin', auth_mode = 'server', server_url = 'https://test.invalid', server_sync_token = 'sync-token', cloud_user_id = 7 WHERE id = 1").run();
  db.prepare('INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('cloud', 1, 'https://test.invalid', 7, GATEWAY, now);
  insertProjected(db, { date: isoDay(-2), rain_quality_reasons: '["frame_gap","received_only"]' });
  insertProjected(db, { date: isoDay(-3), rainfall_mm: 4.5, rain_coverage: 'complete', rain_quality_reasons: '[]', rain_received_mm: 4.5 });
  db.prepare("INSERT INTO zone_daily_environment (zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at, sync_version) VALUES (1, ?, 3.2, 0, 'aquascope_lorain', ?, 1)").run(isoDay(-4), now);
  insertProjected(db, { date: isoDay(-5), rain_quality_reasons: 'not json' });
  return db;
}

function callbackDatabase(db) {
  return class Database {
    all(sql, params, callback) { try { callback(null, db.prepare(sql).all(...(params || [])).map((r) => ({ ...r }))); } catch (error) { callback(error); } }
    run(sql, params, callback) { try { db.prepare(sql).run(...(params || [])); callback(null); } catch (error) { callback(error); } }
    close(callback) { callback(); }
  };
}

function assertZoneEnvironments(items, warnings) {
  assert.ok(Array.isArray(items), 'zoneEnvironments is a list');
  const byDate = Object.fromEntries(items.map((item) => [item.date, item]));
  const partial = byDate[isoDay(-2)];
  assert.deepEqual({ coverage: partial.rain_coverage, deveui: partial.rain_selected_deveui, policy: partial.rain_policy_version, reasons: partial.rain_quality_reasons, received: partial.rain_received_mm, rainfall: partial.rainfall_mm, version: partial.sync_version },
    { coverage: 'partial', deveui: GAUGE, policy: 1, reasons: ['frame_gap', 'received_only'], received: 2.5, rainfall: null, version: 1 });
  const complete = byDate[isoDay(-3)];
  assert.deepEqual(complete.rain_quality_reasons, []);
  assert.equal(complete.rain_coverage, 'complete');
  assert.equal(complete.rainfall_mm, 4.5);
  const legacy = byDate[isoDay(-4)];
  for (const key of QUALITY_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(legacy, key), `legacy item has ${key}`);
    assert.equal(legacy[key], null, `legacy item ${key} null`);
  }
  assert.equal(legacy.rainfall_mm, 3.2);
  const broken = byDate[isoDay(-5)];
  assert.equal(broken.rain_quality_reasons, null, 'unparseable reasons are sent as null, never the raw text');
  assert.equal(broken.rain_coverage, 'partial');
  assert.ok(warnings.some((w) => /rain_quality_reasons/.test(w) && w.includes(isoDay(-5))), 'the parse failure is logged');
}

test('snapshots: bootstrap and force-sync zoneEnvironments carry the five fields, reasons as an array', async () => {
  const db = snapshotDb();
  const Database = callbackDatabase(db);
  const warnings = [];
  const node = { warn: (m) => warnings.push(String(m)), error: () => {}, status: () => {} };
  const flowState = {};
  const flow = { get: (key) => flowState[key] || {}, set: (key, value) => { flowState[key] = value; } };
  const previousGet = global.get;
  global.get = (key) => (key === 'fs' ? { existsSync: () => false } : undefined);
  const env = { get: (key) => ({ DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'test', DEVICE_EUI_CONFIDENCE: 'active', FIRMWARE_VERSION: 'test-build', OSI_SCOPED_ACCESS: '0' }[key] || '') };
  const osiLib = { require(name) {
    if (name === 'installation') return { ok: true, value: installation };
    if (name === 'rejection-recovery') return { ok: true, value: rejection };
    return { ok: false, error: 'unexpected helper ' + name };
  } };
  const calls = [];
  const cloud = { requestJsonIpv4: async (request) => {
    calls.push(request);
    if (request.url.endsWith('/auth/refresh-sync')) return { statusCode: 200, payload: { token: 'sync-token' } };
    if (request.url.endsWith('/api/v1/sync/edge/bootstrap')) return { statusCode: 200, payload: { applied: 1, skipped: 0 } };
    if (request.url.endsWith('/api/v1/sync/edge/events')) return { statusCode: 200, payload: { results: [] } };
    if (request.url.includes('/pending-commands')) return { statusCode: 200, payload: { commands: [] } };
    throw new Error('unexpected request ' + request.url);
  } };
  try {
    const bootstrap = new Function('msg', 'node', 'env', 'flow', 'osiDb', 'osiLib', byId['sync-bootstrap-build'].func);
    const built = await bootstrap({}, node, env, flow, { Database }, osiLib);
    assert.ok(built && built.payload, 'bootstrap built a payload: ' + warnings.join(' | '));
    assertZoneEnvironments(built.payload.zoneEnvironments, warnings);

    warnings.length = 0;
    const force = new Function('msg', 'node', 'env', 'flow', 'crypto', 'osiDb', 'osiCloudHttp', 'osiLib', byId['sync-force-build'].func);
    await force({ _forceSyncInternal: true, _forceSyncUserId: 1, _forceSyncUsername: 'admin1' }, node, env, flow, require('node:crypto'), { Database }, cloud, osiLib);
    const request = calls.find((r) => r.url.endsWith('/api/v1/sync/edge/bootstrap'));
    assert.ok(request, 'force sync posted a bootstrap snapshot: ' + warnings.join(' | '));
    assertZoneEnvironments(request.payload.zoneEnvironments, warnings);
  } finally {
    global.get = previousGet;
  }
});

// ---------------------------------------------------------------------------
// Convergence end to end (Task 3, A21): a partial day completed by a late
// distinct observation converges with one versioned event.
// ---------------------------------------------------------------------------
test('a late rain correction converges with one versioned event; a re-delivery emits nothing', async () => {
  const db = seedTestDb();
  seedGauge(db);
  const chain = dayChain();
  const lost = chain.find((f) => f.fCnt === 3);
  // The gateway links before the noon rain frame: from there on every projected
  // change of 2026-10-08 is an event.
  for (const frame of chain.filter((f) => f.fCnt < 3)) await loRain(db, frame);
  db.prepare('INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES (?, ?, ?, ?)')
    .run('cloud', 1, GATEWAY, '2026-10-01T00:00:00.000Z');
  for (const frame of chain.filter((f) => f.fCnt > 3)) await loRain(db, frame);
  await loRain(db, lost);
  const delivered = zoneEvents(db);
  assert.equal(delivered.length, 2, 'the partial day, then its correction');
  const [partial, complete] = delivered;
  assert.ok(complete.syncVersion > partial.syncVersion, 'increasing sync_version');
  assert.equal(partial.payload.sync_version, partial.syncVersion);
  assert.equal(complete.payload.sync_version, complete.syncVersion);
  assert.deepEqual(
    { coverage: partial.payload.rain_coverage, rainfall: partial.payload.rainfall_mm, received: partial.payload.rain_received_mm, reasons: partial.payload.rain_quality_reasons },
    { coverage: 'partial', rainfall: null, received: 5, reasons: ['frame_gap'] });
  assert.deepEqual(
    { coverage: complete.payload.rain_coverage, rainfall: complete.payload.rainfall_mm, received: complete.payload.rain_received_mm, reasons: complete.payload.rain_quality_reasons },
    { coverage: 'complete', rainfall: 5, received: 5, reasons: [] });
  for (const event of delivered) {
    assert.equal(event.payload.rain_selected_deveui, GAUGE);
    assert.equal(event.payload.rain_policy_version, 1);
    assert.equal(event.payload.rain_source, 'aquascope_lorain');
    assert.equal(event.payload.contract_version, 1);
  }
  assert.ok(complete.payload.computed_at > partial.payload.computed_at);
  // Re-delivering the late observation changes nothing and emits nothing.
  frameSeq -= 1;
  await loRain(db, lost);
  assert.equal(zoneEvents(db).length, 2, 'no third event');
  if (process.env.ZONE_ENV_PRINT_PAYLOADS === '1') console.log(JSON.stringify(delivered.map((e) => e.payload), null, 2));
});
