'use strict';
// Regression test for issue #10: the cloud (osi-server SyncEventTxExecutor)
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
