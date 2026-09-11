'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../../lib/osi-migrate');
const { runAudit, extractTypeIdCheckSet, REBUILD_TABLES, diffTable } = require('./uganda-schema-audit');

const REPO = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-audit-test-'));
  return path.join(dir, 'test.db');
}

// This audit only ever compares against reference(1), so fixtures only need
// migration 0001 applied - NOT the full 53-migration chain. bootstrapFresh's
// per-migration fingerprint stamping is the expensive part (~seconds per
// migration via the sqlite3 CLI; see generate-uganda-catchup-20260911.test.js's
// header comment for the measured cost of doing this over the full chain) -
// building only reference(1) keeps this file fast enough to run in CI.
function ref1MigrationsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-audit-ref1-subset-'));
  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0001__baseline.sql'), path.join(dir, '0001__baseline.sql'));
  return dir;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Builds a reference(1) DB and then mutates it to reproduce, exactly, the
// class of drift the real Uganda copy has: nullable-instead-of-NOT-NULL
// columns, a narrower devices CHECK, a dropped FK declaration, an extra
// live-only column, and a missing column - via a drop/recreate/copy of each
// affected table (the same operation this audit's own future rebuild
// artifact will perform on the real device, just deliberately mis-shapen
// here to simulate "before").
async function buildDriftedFixture(db) {
  await bootstrapFresh(cliRunner(db), { migrationsDir: ref1MigrationsDir(), appVersion: 'test' });
  const runner = cliRunner(db);
  await runner.exec(`
PRAGMA foreign_keys=OFF;
PRAGMA legacy_alter_table=ON;
BEGIN IMMEDIATE;

-- devices: narrower CHECK (drop AQUASCOPE_LORAIN), no data loss (no rows use it)
CREATE TABLE devices_drift (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type_id TEXT NOT NULL CHECK(type_id IN ('KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO devices_drift (id, deveui, name, type_id, created_at, updated_at)
  SELECT id, deveui, name, type_id, created_at, updated_at FROM devices;
DROP TABLE devices;
ALTER TABLE devices_drift RENAME TO devices;
INSERT INTO devices (deveui, name, type_id, created_at, updated_at)
  VALUES ('TESTDEVEUI01', 'test kiwi', 'KIWI_SENSOR', datetime('now'), datetime('now'));

-- zone_irrigation_calibration: nullable instead of NOT NULL, one NULL row planted
CREATE TABLE zic_drift (
  zone_id INTEGER PRIMARY KEY,
  valve_device_eui TEXT,
  measured_flow_rate_lpm REAL,
  measurement_method TEXT,
  measured_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
INSERT INTO zic_drift SELECT * FROM zone_irrigation_calibration;
DROP TABLE zone_irrigation_calibration;
ALTER TABLE zic_drift RENAME TO zone_irrigation_calibration;
INSERT INTO zone_irrigation_calibration (zone_id, valve_device_eui, measured_flow_rate_lpm, measurement_method, measured_at, created_at, updated_at)
  VALUES (9999, NULL, NULL, NULL, NULL, NULL, NULL);

-- zone_weather_cache: extra created_at/updated_at, missing fetched_at, one row
CREATE TABLE zwc_drift (
  zone_id INTEGER NOT NULL,
  cache_key TEXT NOT NULL,
  source TEXT,
  payload_json TEXT NOT NULL,
  observed_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (zone_id, cache_key)
);
INSERT INTO zwc_drift (zone_id, cache_key, payload_json, expires_at)
  VALUES (1, 'et0', '{}', '2026-01-01');
DROP TABLE zone_weather_cache;
ALTER TABLE zwc_drift RENAME TO zone_weather_cache;

COMMIT;
PRAGMA foreign_keys=ON;
PRAGMA legacy_alter_table=OFF;
`);
  return db;
}

test('diffTable resolves index diffs (no dot in the name) to their owning table', () => {
  // Regression: idx_irrigation_events_event_uuid has no table prefix in its
  // diff name, so a naive `name.split('.')[0]` scoping filter silently drops
  // it from the audit (caught 2026-09-11 running against the real Uganda
  // copy: 16 diffs reported instead of the expected 17).
  assert.equal(diffTable({ kind: 'index', name: 'idx_irrigation_events_event_uuid' }), 'irrigation_events');
  assert.equal(diffTable({ kind: 'column', name: 'zone_weather_cache.fetched_at' }), 'zone_weather_cache');
  assert.equal(diffTable({ kind: 'check', name: 'devices' }), 'devices');
});

test('extractTypeIdCheckSet finds the canonical type set in reference(1) DDL', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '0001__baseline.sql'), 'utf8');
  const m = /CREATE TABLE devices \([\s\S]*?\n\);/.exec(sql);
  const types = extractTypeIdCheckSet(m[0]);
  assert.ok(types.includes('AQUASCOPE_LORAIN'));
  assert.ok(types.includes('KIWI_SENSOR'));
  assert.equal(types.length, 6);
});

test('runAudit() is read-only: sha256 of the target DB is unchanged after auditing', async () => {
  const db = tmpDb();
  await bootstrapFresh(cliRunner(db), { migrationsDir: ref1MigrationsDir(), appVersion: 'test' });
  const before = sha256File(db);
  await runAudit({ dbPath: db });
  const after = sha256File(db);
  assert.equal(after, before);
});

test('runAudit() on a clean reference(1)-shaped DB reports zero in-scope diffs', async () => {
  const db = tmpDb();
  await bootstrapFresh(cliRunner(db), { migrationsDir: ref1MigrationsDir(), appVersion: 'test' });
  const result = await runAudit({ dbPath: db });
  assert.deepEqual(result.diffs, []);
  assert.deepEqual(result.devicesTypeIdAudit.outsideCanonical, []);
  assert.equal(result.orphans.device_data_deveui_not_in_devices, 0);
  assert.equal(result.orphans.zone_weather_cache_zone_id_not_in_irrigation_zones, 0);
  for (const t of REBUILD_TABLES) assert.ok(t in result.rowCounts);
});

test('runAudit() on a drifted fixture: NULL counts, CHECK-outside values, and mapping proposal all reflect real data', async () => {
  const db = tmpDb();
  await buildDriftedFixture(db);
  const result = await runAudit({ dbPath: db });

  const byName = Object.fromEntries(result.diffs.map((d) => [`${d.kind}:${d.name}`, d]));

  // devices CHECK narrower than reference(1) -> [changed] check devices
  assert.equal(byName['check:devices'].class, 'changed');

  // zone_irrigation_calibration: every NOT-NULL-bound column has exactly 1 NULL
  // (the one deliberately planted row - a fresh reference(1) DB has none of its own).
  for (const col of ['created_at', 'measured_at', 'measured_flow_rate_lpm', 'measurement_method', 'updated_at']) {
    const d = byName[`column:zone_irrigation_calibration.${col}`];
    assert.ok(d, `expected a diff for zone_irrigation_calibration.${col}`);
    assert.equal(d.dataImplication.value, 1, `expected exactly 1 NULL in ${col}`);
  }
  assert.equal(result.rowCounts.zone_irrigation_calibration, 1);

  // zone_weather_cache: fetched_at missing (1 row would need backfill),
  // expires_at NOT NULL in ref but NULL-capable live (0 actual NULLs - the one
  // row has a value), created_at/updated_at extra_unknown with a mapping proposal.
  assert.equal(byName['column:zone_weather_cache.fetched_at'].dataImplication.value, 1);
  assert.equal(byName['column:zone_weather_cache.expires_at'].dataImplication.value, 0);
  assert.equal(byName['column:zone_weather_cache.created_at'].class, 'extra_unknown');
  assert.equal(byName['column:zone_weather_cache.updated_at'].class, 'extra_unknown');
  assert.equal(result.zoneWeatherCacheMapping.rowCount, 1);
  assert.equal(result.zoneWeatherCacheMapping.sampleRows.length, 1);
  assert.match(result.zoneWeatherCacheMapping.proposedMapping.fetched_at, /created_at/);
});
