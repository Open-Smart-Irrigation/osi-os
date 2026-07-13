'use strict';
// Regression tests for issue #10, issue #5, and issue #15 (all three belong
// to the same equal-version-payload-conflict class; issue #5's and issue
// #15's tests are appended near the end of this file). Issue #10: the cloud
// (osi-server SyncEventTxExecutor)
// keeps a per-resource watermark (highest sync_version + payload hash) and
// terminally rejects an equal-version-different-payload event. The
// dendrometer_daily / zone_daily_recommendations / zone_daily_environment
// outbox triggers used to pass literal 0 as sync_version on every INSERT and
// UPDATE while payloads embed computed_at, so the first delivery pinned
// version 0 and every recompute was rejected (equal_version_payload_conflict).
//
// The fix: each table carries a sync_version column, writers bump it on every
// rewrite (INSERT ... ON CONFLICT DO UPDATE, never INSERT OR REPLACE which
// deletes+reinserts and resets the column), and the outbox triggers pass
// NEW.sync_version with the AFTER UPDATE variants gated on a version change.
//
// This test builds a DB from database/seed-blank.sql, marks sync_link_state
// linked, inserts a dendrometer_daily row, rewrites it writer-style, and
// asserts the outbox events carry different, increasing sync_version values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repoRoot = path.resolve(__dirname, '..');
const SEED = path.join(repoRoot, 'database/seed-blank.sql');
const FLOWS = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

function freshLinkedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(SEED, 'utf8'));
  db.exec(
    "INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at) " +
    "VALUES('cloud', 1, 'https://cloud.example', '1', '0016C001F11715E2', strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
  );
  return db;
}

function outboxRows(db, aggregateType) {
  return db
    .prepare('SELECT op, aggregate_key, sync_version, payload_json FROM sync_outbox WHERE aggregate_type = ? ORDER BY rowid ASC')
    .all(aggregateType);
}

// Writer-shaped upsert for dendrometer_daily (mirrors dendro-compute-fn).
const DENDRO_UPSERT =
  "INSERT INTO dendrometer_daily(deveui,date,mds_um,stress_level,computed_at)" +
  "VALUES('A84041FFFF000001','2026-07-13',?,?,?)" +
  " ON CONFLICT(deveui,date) DO UPDATE SET" +
  " mds_um=excluded.mds_um,stress_level=excluded.stress_level,computed_at=excluded.computed_at," +
  "sync_version=dendrometer_daily.sync_version+1";

test('dendrometer_daily insert + recompute emit different, increasing outbox sync_versions', () => {
  const db = freshLinkedDb();
  db.prepare(DENDRO_UPSERT).run(120.5, 'none', '2026-07-13T20:00:00.000Z');
  db.prepare(DENDRO_UPSERT).run(131.2, 'mild', '2026-07-13T21:00:00.000Z');

  const rows = db.prepare('SELECT id, sync_version FROM dendrometer_daily').all();
  assert.strictEqual(rows.length, 1, 'the recompute must rewrite the same row, not delete+reinsert');
  assert.strictEqual(rows[0].sync_version, 1);

  const events = outboxRows(db, 'DENDRO_DAILY');
  assert.strictEqual(events.length, 2, `expected 2 outbox events, got ${events.length}`);
  assert.ok(events.every((e) => e.op === 'DENDRO_DAILY_UPSERTED'));
  assert.strictEqual(events[0].aggregate_key, events[1].aggregate_key, 'both events address the same resource');
  assert.notStrictEqual(events[0].sync_version, events[1].sync_version, 'versions must differ (equal versions are terminally rejected by the cloud)');
  assert.ok(events[1].sync_version > events[0].sync_version, 'versions must increase');
  for (const e of events) {
    assert.strictEqual(JSON.parse(e.payload_json).sync_version, e.sync_version, 'payload_json mirrors the outbox sync_version');
  }
  db.close();
});

test('zone_daily_recommendations + zone_daily_environment recomputes also increase versions', () => {
  const db = freshLinkedDb();
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES(1,'u','h','now')");
  db.exec("INSERT INTO irrigation_zones(id, user_id, name, created_at) VALUES(7, 1, 'zone-7', 'now')");

  const recUpsert =
    "INSERT INTO zone_daily_recommendations(zone_id,date,zone_stress_summary,computed_at)" +
    "VALUES(7,'2026-07-13',?,?)" +
    " ON CONFLICT(zone_id,date) DO UPDATE SET" +
    " zone_stress_summary=excluded.zone_stress_summary,computed_at=excluded.computed_at," +
    "sync_version=zone_daily_recommendations.sync_version+1";
  db.prepare(recUpsert).run('none', '2026-07-13T20:00:00.000Z');
  db.prepare(recUpsert).run('moderate', '2026-07-13T21:00:00.000Z');
  const recEvents = outboxRows(db, 'ZONE_RECOMMENDATION');
  assert.strictEqual(recEvents.length, 2);
  assert.ok(recEvents[1].sync_version > recEvents[0].sync_version, 'ZONE_RECOMMENDATION versions must increase');

  const envUpsert =
    "INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,rain_source,computed_at)" +
    "VALUES(7,'2026-07-13',?, 'local_gauge', ?)" +
    " ON CONFLICT(zone_id,date) DO UPDATE SET" +
    " rainfall_mm=rainfall_mm+excluded.rainfall_mm,computed_at=excluded.computed_at," +
    "sync_version=zone_daily_environment.sync_version+1";
  db.prepare(envUpsert).run(1.2, '2026-07-13T20:00:00.000Z');
  db.prepare(envUpsert).run(0.8, '2026-07-13T21:00:00.000Z');
  const envEvents = outboxRows(db, 'ZONE_ENVIRONMENT');
  assert.strictEqual(envEvents.length, 2);
  assert.ok(envEvents[1].sync_version > envEvents[0].sync_version, 'ZONE_ENVIRONMENT versions must increase');
  db.close();
});

test('an UPDATE that does not change sync_version emits no outbox event (AU gate)', () => {
  const db = freshLinkedDb();
  db.prepare(DENDRO_UPSERT).run(120.5, 'none', '2026-07-13T20:00:00.000Z');
  db.exec("UPDATE dendrometer_daily SET stress_level='none' WHERE deveui='A84041FFFF000001'");
  const events = outboxRows(db, 'DENDRO_DAILY');
  assert.strictEqual(events.length, 1, 'a no-version-change rewrite must not spam the outbox');
  db.close();
});

test('the shipped writers use version-bumping upserts, not INSERT OR REPLACE', () => {
  const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
  const fnOf = (id) => flows.find((n) => n && n.id === id).func;

  const dendroCompute = fnOf('dendro-compute-fn');
  assert.ok(!/INSERT OR REPLACE INTO dendrometer_daily/.test(dendroCompute), 'INSERT OR REPLACE deletes+reinserts and resets sync_version');
  assert.ok(!/INSERT OR REPLACE INTO zone_daily_recommendations/.test(dendroCompute));
  assert.ok(dendroCompute.includes('sync_version=dendrometer_daily.sync_version+1'));
  assert.ok(dendroCompute.includes('sync_version=zone_daily_recommendations.sync_version+1'));

  for (const id of ['lsn50-zone-agg-fn', 's2120-rain-agg-fn', 'lorain-rain-agg-fn']) {
    assert.ok(fnOf(id).includes('sync_version=zone_daily_environment.sync_version+1'), `${id} must bump zone_daily_environment.sync_version`);
  }

  const sim = fnOf('sim-dendro-fn-setup');
  assert.ok(!/INSERT OR REPLACE INTO (dendrometer_daily|zone_daily_recommendations)/.test(sim));
  assert.ok(sim.includes('sync_version=dendrometer_daily.sync_version+1'));
  assert.ok(sim.includes('sync_version=zone_daily_recommendations.sync_version+1'));
});

// Regression test for issue #5: a Chameleon-enabled LSN50 appeared as a plain
// LSN50 in the cloud because trg_sync_devices_outbox_au omitted
// chameleon_enabled from both its change-detection WHEN clause and its
// json_object payload, and the chameleon-enable endpoint's UPDATE never
// bumped devices.sync_version. The trigger fix alone would have reintroduced
// the equal-version-payload-conflict class fixed for issue #10 (an UPDATE
// that flips chameleon_enabled but leaves sync_version unchanged still fires
// the WHEN clause via the flag-changed OR branch, emitting an event whose
// sync_version equals the previously-delivered watermark with a different
// payload, which the cloud terminally rejects) — so the endpoint fix (mirrors
// the dendro_enabled/temp_enabled/rain_gauge_enabled/flow_meter_enabled
// precedent) is asserted together with the payload/version behavior below.
test('enabling Chameleon on a device emits a DEVICE event with chameleon_enabled in the payload and an increasing sync_version', () => {
  const db = freshLinkedDb();
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES(1,'u','h','now')");
  db.exec(
    "INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) " +
    "VALUES('A84041FFFF000099','LSN50-1','DRAGINO_LSN50',1,'2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z')"
  );

  const before = db.prepare("SELECT sync_version, chameleon_enabled FROM devices WHERE deveui='A84041FFFF000099'").get();
  assert.strictEqual(before.chameleon_enabled, 0, 'chameleon_enabled defaults to 0');

  // Writer-shaped UPDATE mirroring the fixed put-chameleon-enabled-auth-fn SQL.
  db.prepare(
    "UPDATE devices SET chameleon_enabled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), " +
    "sync_version = COALESCE(sync_version, 0) + 1 WHERE deveui = 'A84041FFFF000099' AND user_id = 1 " +
    "AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL"
  ).run();

  const after = db.prepare("SELECT sync_version, chameleon_enabled FROM devices WHERE deveui='A84041FFFF000099'").get();
  assert.strictEqual(after.chameleon_enabled, 1, 'chameleon_enabled was persisted');
  assert.ok(after.sync_version > before.sync_version, 'sync_version must increase on the chameleon_enabled toggle');

  const events = outboxRows(db, 'DEVICE');
  assert.ok(events.length >= 2, `expected at least an insert-defaults event plus the chameleon-enable event, got ${events.length}`);
  const last = events[events.length - 1];
  const payload = JSON.parse(last.payload_json);
  assert.strictEqual(payload.chameleon_enabled, 1, 'DEVICE outbox payload must carry chameleon_enabled');
  assert.strictEqual(last.sync_version, after.sync_version, 'outbox sync_version mirrors the row');
  assert.ok(last.sync_version > events[0].sync_version, 'versions must increase (equal versions are terminally rejected by the cloud)');
  db.close();
});

test('the shipped Chameleon endpoints bump devices.sync_version and the bootstrap/force-sync device SELECTs carry chameleon fields', () => {
  const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
  const fnOf = (id) => flows.find((n) => n && n.id === id).func;

  const enableFn = fnOf('put-chameleon-enabled-auth-fn');
  assert.ok(enableFn.includes('sync_version = COALESCE(sync_version, 0) + 1'), 'chameleon enable endpoint must bump sync_version');

  const depthFn = fnOf('bf93cd55db0eb57f');
  assert.ok(depthFn.includes('sync_version = COALESCE(sync_version, 0) + 1'), 'chameleon depth endpoint must bump sync_version');

  for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
    const sel = fnOf(id);
    assert.ok(sel.includes('d.chameleon_enabled'), `${id} devices SELECT must include chameleon_enabled`);
    assert.ok(sel.includes('d.chameleon_swt1_depth_cm'), `${id} devices SELECT must include chameleon_swt1_depth_cm`);
    assert.ok(sel.includes('d.chameleon_swt2_depth_cm'), `${id} devices SELECT must include chameleon_swt2_depth_cm`);
    assert.ok(sel.includes('d.chameleon_swt3_depth_cm'), `${id} devices SELECT must include chameleon_swt3_depth_cm`);
  }
});

// Regression test for issue #15: the reference-tree endpoint
// (dendro-ref-tree-fn, PUT /api/devices/:deveui/reference-tree) updated
// devices.is_reference_tree without bumping devices.sync_version, unlike
// every other device-flag endpoint (dendro_enabled/temp_enabled/
// rain_gauge_enabled/flow_meter_enabled/chameleon_enabled all bump it).
// is_reference_tree is already in trg_sync_devices_outbox_au's WHEN clause
// and json_object payload (verified against sync-init-fn), so the trigger
// itself was correct; the missing piece was solely the sync_version bump on
// the endpoint's UPDATE. Without it, a reference-tree toggle after the first
// delivered DEVICE event emits an equal-version-different-payload event,
// which the cloud terminally rejects (equal_version_payload_conflict) — the
// same class of bug fixed for issue #10 and issue #5.
test('toggling is_reference_tree on a device emits a DEVICE event with is_reference_tree in the payload and an increasing sync_version', () => {
  const db = freshLinkedDb();
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES(1,'u','h','now')");
  db.exec(
    "INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) " +
    "VALUES('A84041FFFF0000AA','DENDRO-1','TEKTELIC_CLOVER',1,'2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z')"
  );

  const before = db.prepare("SELECT sync_version, is_reference_tree FROM devices WHERE deveui='A84041FFFF0000AA'").get();
  assert.strictEqual(before.is_reference_tree, 0, 'is_reference_tree defaults to 0');

  // Writer-shaped UPDATE mirroring the fixed dendro-ref-tree-fn SQL.
  db.prepare(
    "UPDATE devices SET is_reference_tree=1, sync_version = COALESCE(sync_version, 0) + 1 WHERE deveui='A84041FFFF0000AA'"
  ).run();

  const after = db.prepare("SELECT sync_version, is_reference_tree FROM devices WHERE deveui='A84041FFFF0000AA'").get();
  assert.strictEqual(after.is_reference_tree, 1, 'is_reference_tree was persisted');
  assert.ok(after.sync_version > before.sync_version, 'sync_version must increase on the is_reference_tree toggle');

  const events = outboxRows(db, 'DEVICE');
  assert.ok(events.length >= 2, `expected at least an insert-defaults event plus the reference-tree event, got ${events.length}`);
  const last = events[events.length - 1];
  const payload = JSON.parse(last.payload_json);
  assert.strictEqual(payload.is_reference_tree, 1, 'DEVICE outbox payload must carry is_reference_tree');
  assert.strictEqual(last.sync_version, after.sync_version, 'outbox sync_version mirrors the row');
  assert.ok(last.sync_version > events[0].sync_version, 'versions must increase (equal versions are terminally rejected by the cloud)');
  db.close();
});

test('the shipped reference-tree endpoint bumps devices.sync_version', () => {
  const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
  const refTreeFn = flows.find((n) => n && n.id === 'dendro-ref-tree-fn').func;
  assert.ok(refTreeFn.includes('sync_version = COALESCE(sync_version, 0) + 1'), 'reference-tree endpoint must bump sync_version');
});
