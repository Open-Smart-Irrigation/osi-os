#!/usr/bin/env node
// Guard for issue #68 — persisted gateway CPU/health reporting.
// Covers: ordered migration 0002, seed schema parity objects, flow-node wiring
// in both full profiles, and the SHIPPED INSERT/ROLLUP SQL executed against the
// real seed schema (extracted from flows.json, not a copy).
// Run: node --test scripts/test-gateway-health-persistence.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const MIGRATION = path.join(MIGRATIONS_DIR, '0002__gateway_health.sql');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const FLOW_PATHS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((rel) => path.join(REPO, rel));

const EUI = '0016C001F11766E7';
const SAMPLE_COLUMNS = [
  'id', 'gateway_device_eui', 'sampled_at', 'cpu_temp_c', 'mem_percent',
  'load_1', 'load_5', 'load_15', 'fan_value', 'throttled', 'created_at',
];
const HOURLY_COLUMNS = [
  'gateway_device_eui', 'hour_start', 'sample_count',
  'cpu_temp_c_min', 'cpu_temp_c_mean', 'cpu_temp_c_max',
  'mem_percent_min', 'mem_percent_mean', 'mem_percent_max',
  'load_1_min', 'load_1_mean', 'load_1_max',
  'load_5_min', 'load_5_mean', 'load_5_max',
  'load_15_min', 'load_15_mean', 'load_15_max',
  'fan_value_min', 'fan_value_mean', 'fan_value_max',
  'throttled_max', 'computed_at',
];

function seedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghealth-'));
  const db = new DatabaseSync(path.join(dir, 'seed.db'));
  db.exec(fs.readFileSync(SEED, 'utf8'));
  return db;
}
function columnNames(db, table) {
  return db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(table).map((r) => r.name);
}
function flowNodesById(flowPath) {
  const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  return Object.fromEntries(flows.filter((n) => n.id).map((n) => [n.id, n]));
}
function extract(func, varName) {
  const m = new RegExp(`var ${varName} = "([^"]+)";`).exec(func || '');
  assert.ok(m, `${varName} string literal not found in function node`);
  return m[1];
}

test('migration 0002__gateway_health.sql is registered as additive', () => {
  const m = loadMigrations(MIGRATIONS_DIR).find((x) => x.version === 2);
  assert.ok(m, 'expected database/migrations/ordered/0002__gateway_health.sql');
  assert.equal(m.slug, 'gateway_health');
  assert.equal(m.risk, 'additive');
});

test('seed-blank.sql contains the gateway health schema objects', () => {
  const db = seedDb();
  const names = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'gateway_health%' OR name LIKE 'idx_gateway_health%'"
  ).all().map((r) => r.name));
  for (const expected of [
    'gateway_health_samples', 'gateway_health_hourly',
    'idx_gateway_health_samples_eui_time', 'idx_gateway_health_samples_time',
    'idx_gateway_health_hourly_time',
  ]) {
    assert.ok(names.has(expected), `missing schema object in seed: ${expected}`);
  }
  assert.deepEqual(columnNames(db, 'gateway_health_samples'), SAMPLE_COLUMNS);
  assert.deepEqual(columnNames(db, 'gateway_health_hourly'), HOURLY_COLUMNS);
  db.close();
});

test('migration 0002 is idempotent (IF NOT EXISTS — safe for deploy.sh re-runs and later ledger adoption)', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  db.exec(sql); // second run must not throw
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  assert.ok(names.has('gateway_health_samples'));
  assert.ok(names.has('gateway_health_hourly'));
  db.close();
});

for (const flowPath of FLOW_PATHS) {
  const rel = path.relative(REPO, flowPath);

  test(`${rel}: gateway-health-sample-tick drives the persist node (own 60s inject, Build Heartbeat untouched)`, () => {
    const byId = flowNodesById(flowPath);
    const tick = byId['gateway-health-sample-tick'];
    assert.ok(tick, 'gateway-health-sample-tick missing');
    assert.equal(tick.type, 'inject');
    assert.equal(tick.repeat, '60');
    assert.deepEqual(tick.wires, [['gateway-health-persist-fn']]);
    const hb = byId['062a0f9bf66d9789'];
    assert.ok(hb, 'Build Heartbeat node missing');
    assert.deepEqual(hb.wires, [['d769e9face3844d5']], 'Build Heartbeat wiring must stay untouched (no tee)');
  });

  test(`${rel}: persist node shape (libs, close, INSERT SQL, self-sampling)`, () => {
    const byId = flowNodesById(flowPath);
    const n = byId['gateway-health-persist-fn'];
    assert.ok(n, 'gateway-health-persist-fn missing');
    assert.equal(n.type, 'function');
    assert.equal(n.z, '93b1537a596e0e6d');
    assert.ok((n.libs || []).some((l) => l.var === 'osiDb' && l.module === 'osi-db-helper'),
      'osiDb libs entry missing');
    assert.match(n.func, /\.close\s*\(/);
    const insertSql = extract(n.func, 'INSERT_SQL');
    assert.match(insertSql, /^INSERT INTO gateway_health_samples /);
    assert.match(n.func, /get_throttled/);
    assert.match(n.func, /thermal_zone0/);
    assert.match(n.func, /DEVICE_EUI/);
    assert.match(n.func, /pwmfan/);
    assert.match(n.func, /pwmchip2/);
  });

  test(`${rel}: rollup tick + rollup node shape (cron, libs, close, retention SQL)`, () => {
    const byId = flowNodesById(flowPath);
    const tick = byId['gateway-health-rollup-tick'];
    assert.ok(tick, 'gateway-health-rollup-tick missing');
    assert.equal(tick.type, 'inject');
    assert.equal(tick.crontab, '10 2 * * *');
    assert.deepEqual(tick.wires, [['gateway-health-rollup-fn']]);
    const fn = byId['gateway-health-rollup-fn'];
    assert.ok(fn, 'gateway-health-rollup-fn missing');
    assert.ok((fn.libs || []).some((l) => l.var === 'osiDb' && l.module === 'osi-db-helper'),
      'osiDb libs entry missing');
    assert.match(fn.func, /\.close\s*\(/);
    assert.match(fn.func, /DELETE FROM gateway_health_samples WHERE sampled_at < \?/);
    assert.match(fn.func, /DELETE FROM gateway_health_hourly WHERE hour_start < \?/);
    assert.match(fn.func, /OSI_HEALTH_RAW_RETENTION_DAYS/);
    assert.match(fn.func, /OSI_HEALTH_HOURLY_RETENTION_DAYS/);
    extract(fn.func, 'ROLLUP_SQL');
  });
}

test('shipped INSERT_SQL + ROLLUP_SQL execute correctly against the seed schema', () => {
  const byId = flowNodesById(FLOW_PATHS[0]);
  const insertSql = extract(byId['gateway-health-persist-fn'].func, 'INSERT_SQL');
  const rollupSql = extract(byId['gateway-health-rollup-fn'].func, 'ROLLUP_SQL');
  const db = seedDb();
  const ins = db.prepare(insertSql);
  // Kaba100-outage-shaped fixture: one hot/throttled hour, one calm hour.
  ins.run(EUI, '2026-06-28T09:00:12.000Z', 61.2, 38, 0.42, 0.31, 0.22, 120, 0);
  ins.run(EUI, '2026-06-28T09:01:12.000Z', 72.8, 39, 1.9, 0.8, 0.35, 200, 262148); // 0x40004
  ins.run(EUI, '2026-06-28T09:02:12.000Z', 66.1, 40, 0.95, 0.6, 0.3, 160, 262144); // 0x40000
  ins.run(EUI, '2026-06-28T10:00:12.000Z', 55.0, 36, 0.2, 0.25, 0.2, 90, 0);
  ins.run(EUI, new Date().toISOString(), 50.0, 30, 0.1, 0.1, 0.1, null, null); // current (open) hour

  db.exec(rollupSql);
  db.exec(rollupSql); // must be idempotent

  const rows = db.prepare(
    "SELECT * FROM gateway_health_hourly WHERE gateway_device_eui = ? AND hour_start LIKE '2026-06-28%' ORDER BY hour_start"
  ).all(EUI);
  assert.equal(rows.length, 2);
  const h9 = rows[0];
  assert.equal(h9.hour_start, '2026-06-28T09:00:00Z');
  assert.equal(h9.sample_count, 3);
  assert.equal(h9.cpu_temp_c_min, 61.2);
  assert.equal(h9.cpu_temp_c_max, 72.8);
  assert.ok(Math.abs(h9.cpu_temp_c_mean - (61.2 + 72.8 + 66.1) / 3) < 1e-9);
  assert.equal(h9.throttled_max, 262148);
  assert.equal(h9.fan_value_max, 200);
  assert.equal(rows[1].hour_start, '2026-06-28T10:00:00Z');
  assert.equal(rows[1].sample_count, 1);

  // The still-open current hour must NOT be rolled up.
  const nowBucket = new Date().toISOString().slice(0, 13) + ':00:00Z';
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM gateway_health_hourly WHERE hour_start = ?').get(nowBucket).n, 0);

  // Retention semantics: pruning raw rows must not remove hourly rollups.
  db.prepare('DELETE FROM gateway_health_samples WHERE sampled_at < ?').run('2026-06-29T00:00:00.000Z');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM gateway_health_samples').get().n, 1); // current-hour row survives
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM gateway_health_hourly WHERE hour_start LIKE '2026-06-28%'").get().n, 2);
  db.close();
});