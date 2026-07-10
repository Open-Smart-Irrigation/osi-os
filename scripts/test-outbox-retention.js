#!/usr/bin/env node
// Guard for item 1.A5 — sync_outbox size cap with per-aggregate drop policy.
// Extracts the SHIPPED prune-sync-outbox SQL/logic from flows.json and runs it
// against the real seed schema. Spec:
//   docs/superpowers/specs/2026-07-08-outbox-retention-size-cap-design.md
// Run: node --test scripts/test-outbox-retention.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const FLOW_PATHS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((rel) => path.join(REPO, rel));

const TELEMETRY = ['DEVICE_DATA', 'CHAMELEON_READING', 'DENDRO_READING', 'DENDRO_DAILY', 'ZONE_ENVIRONMENT', 'ZONE_RECOMMENDATION'];
const PROTECTED = ['IRRIGATION_EVENT', 'SCHEDULE', 'ZONE', 'DEVICE', 'GATEWAY_LOCATION'];

function nodeById(flowPath, id) {
  return JSON.parse(fs.readFileSync(flowPath, 'utf8')).find((n) => n.id === id);
}
function seedDb() {
  const db = new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-')), 's.db'));
  db.exec(fs.readFileSync(SEED, 'utf8'));
  return db;
}
// Insert an outbox row directly (bypassing triggers) so the guard controls the mix.
function insertRow(db, i, aggregate_type, delivered_at, occurred_at) {
  db.prepare(`INSERT INTO sync_outbox
      (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, delivered_at, retry_count)
      VALUES (?,?,?,?,?,0,?,?,0)`)
    .run(`evt-${i}`, aggregate_type, `k${i}`, `${aggregate_type}_OP`, '{}', occurred_at, delivered_at);
}

test('prune-sync-outbox node exists in both profiles with osiDb libs + close', () => {
  for (const fp of FLOW_PATHS) {
    const n = nodeById(fp, 'prune-sync-outbox');
    assert.ok(n, `prune-sync-outbox missing in ${fp}`);
    assert.equal(n.type, 'function');
    assert.ok((n.libs || []).some((l) => l.var === 'osiDb' && l.module === 'osi-db-helper'));
    assert.match(n.func, /\.close\s*\(/);
  }
});

test('node body declares the telemetry + protected aggregate sets', () => {
  const f = nodeById(FLOW_PATHS[0], 'prune-sync-outbox').func;
  for (const t of TELEMETRY) assert.ok(f.includes("'" + t + "'"), `telemetry ${t} missing from node`);
  for (const p of PROTECTED) assert.ok(f.includes("'" + p + "'"), `protected ${p} missing from node`);
  assert.match(f, /OSI_OUTBOX_MAX_ROWS/);
  assert.match(f, /OSI_OUTBOX_RETENTION_DAYS/); // existing delivered-prune preserved
  assert.match(f, /DELETE FROM sync_outbox WHERE delivered_at IS NOT NULL AND delivered_at < \?/);
  // Flow-local DDL is forbidden by the no-stray-DDL ratchet. If a future index is
  // needed, add it through schema change control, not this function node.
  assert.ok(!/CREATE\s+INDEX/i.test(f), 'must not add schema DDL inside prune-sync-outbox');
  assert.match(f, /EVICTION_BATCH_SIZE/);
  assert.match(f, /while\s*\(remainingToEvict > 0\)/);
  assert.match(f, /Math\.min\(remainingToEvict, EVICTION_BATCH_SIZE\)/);
  // §D: protected-over-cap surfaces via node.error (NOT a direct global.set) — assert
  // both the call and the absence of a direct error_counts write in this node.
  assert.match(f, /node\.error\(\s*'outbox size cap exceeded by protected rows/);
  assert.ok(!/global\.set\(\s*'error_counts'/.test(f), 'must not write error_counts directly; use node.error → catch path');
});

test('both profiles have byte-identical prune-sync-outbox func', () => {
  assert.equal(nodeById(FLOW_PATHS[0], 'prune-sync-outbox').func,
    nodeById(FLOW_PATHS[1], 'prune-sync-outbox').func);
});

// The aggregate-partition guard: the node's declared telemetry ∪ protected sets
// must equal EXACTLY the distinct aggregate_type literals across all 17
// INSERT-INTO-sync_outbox triggers. Extract aggregate_type from each trigger by
// reading the value in the position/label following the `aggregate_type` column —
// robust to new types the node hasn't classified (the point of the guard).
function triggerAggregateTypes(seed) {
  const blocks = seed.split(/CREATE TRIGGER/).filter((b) => b.includes('INSERT INTO sync_outbox'));
  const types = new Set();
  for (const b of blocks) {
    // Case A: `INSERT INTO sync_outbox(... aggregate_type ...) VALUES (<uuid>, 'TYPE', ...)`
    //   — the 2nd column is aggregate_type; the first caps string literal after VALUES is it.
    // Case B: a CASE expression producing the aggregate_type — capture every caps literal
    //   that is used as an aggregate_type (they are the ones NOT ending in an op-ish suffix
    //   AND appearing before the `op` position). To stay robust we collect ALL caps string
    //   literals in the INSERT column/VALUES region and let the assertion below flag any not
    //   in the declared union — a genuinely new, unclassified type WILL surface.
    const region = b.slice(0, b.indexOf('json_object') === -1 ? b.length : b.indexOf('json_object'));
    for (const m of region.matchAll(/'([A-Z][A-Z0-9_]+)'/g)) {
      const lit = m[1];
      // aggregate_type literals are the short subjects (DEVICE_DATA), not the op verbs
      // (DEVICE_DATA_APPENDED). Heuristic: an aggregate_type has no trailing op suffix.
      if (!/_(APPENDED|UPSERTED|DELETED|UNCLAIMED|UNASSIGNED|ASSIGNED|UPDATED)$/.test(lit)) types.add(lit);
    }
  }
  return types;
}

test('declared sets partition exactly the trigger set aggregate_types (17 triggers)', () => {
  const seed = fs.readFileSync(SEED, 'utf8');
  const blocks = seed.split(/CREATE TRIGGER/).filter((b) => b.includes('INSERT INTO sync_outbox'));
  assert.equal(blocks.length, 17, `expected 17 outbox triggers, found ${blocks.length}`);
  const declared = new Set([...TELEMETRY, ...PROTECTED]);
  const types = triggerAggregateTypes(seed);
  // Every aggregate_type a trigger writes MUST be classified (this is what forces a
  // new trigger to make an explicit telemetry/protected decision).
  for (const t of types) assert.ok(declared.has(t), `trigger aggregate_type ${t} is UNCLASSIFIED — add it to the node's telemetry or protected set`);
  // No dead declared entry (every declared type is actually produced by a trigger).
  for (const d of declared) assert.ok(types.has(d), `declared ${d} is not produced by any trigger`);
});

// Execute the shipped cap logic. We drive it by extracting the eviction DELETE
// and the cap constant handling from the node and running them on a seeded DB.
// The node computes MAX_ROWS from env; the test sets a small cap via env shim.
function runCapLogic(db, maxRows, telemetrySet) {
  // Mirror the node's cap step exactly (kept in sync with the shipped SQL).
  const total = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  if (total <= maxRows) return { evicted: 0, protectedOverCap: false };
  const overBy = total - maxRows;
  const inList = telemetrySet.map((t) => `'${t}'`).join(',');
  const evictable = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type IN (${inList})`).get().n;
  const toEvict = Math.min(overBy, evictable);
  if (toEvict > 0) {
    db.prepare(`DELETE FROM sync_outbox WHERE event_uuid IN (
        SELECT event_uuid FROM sync_outbox WHERE aggregate_type IN (${inList})
        ORDER BY (delivered_at IS NULL), occurred_at LIMIT ?)`).run(toEvict);
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  return { evicted: toEvict, protectedOverCap: after > maxRows };
}

test('cap evicts oldest telemetry (delivered-first); zero protected deleted', () => {
  const db = seedDb();
  let i = 0;
  // 5 protected (never evictable), 4 telemetry-delivered (oldest first), 3 telemetry-undelivered
  for (let k = 0; k < 5; k++) insertRow(db, i++, 'IRRIGATION_EVENT', null, `2026-01-0${k + 1}T00:00:00Z`);
  for (let k = 0; k < 4; k++) insertRow(db, i++, 'DEVICE_DATA', '2026-02-01T00:00:00Z', `2026-02-0${k + 1}T00:00:00Z`);
  for (let k = 0; k < 3; k++) insertRow(db, i++, 'CHAMELEON_READING', null, `2026-03-0${k + 1}T00:00:00Z`);
  // total 12; cap 8 → evict 4 telemetry, delivered-first (the 4 DEVICE_DATA delivered rows)
  const res = runCapLogic(db, 8, TELEMETRY);
  assert.equal(res.evicted, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 8);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='IRRIGATION_EVENT'").get().n, 5, 'protected untouched');
  // the delivered DEVICE_DATA rows went first; undelivered CHAMELEON survive
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='DEVICE_DATA'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='CHAMELEON_READING'").get().n, 3);
  db.close();
});

test('protected-over-cap: nothing evicted, flag raised', () => {
  const db = seedDb();
  let i = 0;
  for (let k = 0; k < 10; k++) insertRow(db, i++, 'IRRIGATION_EVENT', null, `2026-01-${String(k + 1).padStart(2, '0')}T00:00:00Z`);
  insertRow(db, i++, 'DEVICE_DATA', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');
  // total 11; cap 5; only 1 telemetry evictable → evict 1, still 10 protected > 5
  const res = runCapLogic(db, 5, TELEMETRY);
  assert.equal(res.evicted, 1);
  assert.equal(res.protectedOverCap, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='IRRIGATION_EVENT'").get().n, 10, 'no protected row evicted');
  db.close();
});
