# Gateway Health Persistence — Persist Aggregated Gateway CPU Health Reporting (osi-os #68)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes (learned from prior plans):** (1) work inside a feature worktree/branch, not the root `main` checkout; (2) after every edit to `conf/full_raspberrypi_bcm27xx_bcm2712/files/...`, mirror it byte-for-byte into `conf/full_raspberrypi_bcm27xx_bcm2709/files/...` with `cp` — `scripts/verify-profile-parity.js` (chained from `verify-sync-flow.js`) hashes the mirror; (3) `flows.json` is exactly `JSON.stringify(flows, null, 2) + '\n'` (verified round-trip byte-identical on main) — always edit it with the Node script in Task 3, never by hand; (4) any new function node that touches `osiDb` MUST declare `"libs": [{"var":"osiDb","module":"osi-db-helper"}]` and contain a `.close(` call, or `scripts/test-flows-wiring.js` fails.
> **Worktree note:** every `cd /home/phil/Repos/osi-os` (or bare `cd`) shown in this plan's commands means **the worktree root** for this feature branch, not the shared main checkout — run all steps from wherever this feature worktree is checked out.

**Goal:** The 60 s Node-RED heartbeat reads `/sys/class/thermal/thermal_zone0/temp`, memory, loadavg, and fan PWM, and publishes them as live MQTT telemetry only — nothing lands in edge SQLite, so outage analysis (e.g. the 2026-06-28 kaba100 investigation) cannot ask "was the Pi throttling when the gap started?". Persist that heartbeat locally in `/data/db/farming.db` with bounded retention and hourly min/mean/max rollups, queryable per gateway + time window, and document it for operators.

**Architecture:** One additive ordered migration (`database/migrations/ordered/0002__gateway_health.sql`) defines two new tables: `gateway_health_samples` (raw 60 s rows, 14-day retention) and `gateway_health_hourly` (min/mean/max rollups, 365-day retention). The same DDL is appended to `database/seed-blank.sql` (fingerprint parity for `verify-seed-replay.js`) and applied to all 7 bundled `farming.db` copies. In `flows.json`, a new function node `gateway-health-persist-fn` is driven by its own 60s inject `gateway-health-sample-tick` — it self-samples the same sysfs/os facts the `Build Heartbeat` node reads (no tee, no wiring change to the heartbeat producer) — and inserts one row per sample. A new daily inject (`10 2 * * *`) drives `gateway-health-rollup-fn`, which re-aggregates every closed hour still in the raw window with idempotent `INSERT OR REPLACE`, then prunes both tables (mirrors the `outbox-retention-tick` → `Prune Sync Outbox` precedent). Live Pis get the schema at deploy time via a new `ensure_gateway_health_schema` function in `deploy.sh` that fetches and executes the migration file itself (single source of DDL truth), following the existing `ensure_analysis_views_schema` / `ensure_chameleon_schema` precedent. The boot-time `sync-init-fn` node is FROZEN and is not touched.

**Tech Stack:** SQLite (sqlite3 CLI 3.53 on the workstation/CI; `/srv/node-red/node_modules/sqlite3` on the Pi), Node-RED function nodes using the `osi-db-helper` facade, `lib/osi-migrate` ordered-migration runner conventions, `node:test` + `node:sqlite` (Node ≥ 22, same as `rehearse-devices-rebuild.test.js`) for the guard test. No new dependencies.

## Design decisions (owned by this plan) and rationale

| Decision | Choice | Rationale |
|---|---|---|
| Sampling cadence | Own 60 s inject `gateway-health-sample-tick` drives `gateway-health-persist-fn`, which self-samples the same sysfs/os facts `Build Heartbeat` reads | Keeps the heartbeat producer node (and its MQTT wiring) completely untouched — no risk to the existing cloud telemetry path from a persistence change; the persist node's read logic is copied verbatim from `Build Heartbeat` so DB values match what the cloud heartbeat sees at the same cadence. A raw row every 60 s also makes *sampling gaps themselves* evidence of Node-RED/Pi downtime. |
| Rollup shape | Hourly `min/mean/max` per metric + `sample_count` + `throttled_max` | Issue #68 suggests "hourly or minute rollups with min/mean/max". Minute-level detail already exists in the raw table for the recent window; hourly is the right long-term grain for "was it hot/loaded that afternoon?". |
| Raw retention | 14 days (env-overridable `OSI_HEALTH_RAW_RETENTION_DAYS`) | The kaba100 investigation looked at day/week windows; 14 days of minute data ≈ 20,160 rows ≈ ~2 MB incl. indexes — bounded and trivial next to `device_data`. |
| Hourly retention | 365 days (env-overridable `OSI_HEALTH_HOURLY_RETENTION_DAYS`) | Season-over-season thermal trends; 8,760 rows/yr ≈ ~1.5 MB. Bounded. |
| Rollup/prune job | One daily inject at `10 2 * * *` (offset from the existing 02:00 jobs) that re-aggregates **all** closed hours still present in raw with `INSERT OR REPLACE` | Idempotent and self-healing: a Pi that was off at 02:10 catches up the next night, as long as the gap < raw retention. Mirrors `outbox-retention-tick`/`history-rollups-schedule` cron precedent. |
| Throttling/undervoltage | Best-effort read of `/sys/devices/platform/soc/soc:firmware/get_throttled` in the persist node (try/catch → `NULL` if the sysfs node is absent) | `bcm27xx-utils` (which provides `vcgencmd`) IS enabled in both full profiles (`CONFIG_PACKAGE_bcm27xx-utils=y` in both `conf/full_raspberrypi_bcm27xx_bcm2712/.config` and the bcm2709 mirror) — so this is not a vcgencmd-availability question. The sysfs node is still the right choice here because it is a plain synchronous file read with no subprocess spawn every 60 s, matching the rest of the heartbeat's sysfs-only read pattern; it answers the motivating question directly, and storing the raw bitfield keeps all 8 flag bits. If the kernel doesn't expose it, the column is simply NULL — no failure mode. |
| Table names / keying | `gateway_health_samples` / `gateway_health_hourly`, keyed by `gateway_device_eui` (from the heartbeat payload / `DEVICE_EUI` env) | Matches the `gateway_health` naming already reserved in `docs/ux/history-data-visualization-redesign-spec.md`. No FK to `devices` — the gateway EUI is not a `devices` row (that table holds LoRa sensors/actuators). Keyed by EUI so future cloud merge/fleet views stay possible. |
| Cloud sync | **NOT synced in v1.** No outbox triggers, not registered in the history-sync workers. | Health data is for on-box outage analysis; the cloud already receives live heartbeats. Avoids touching sync workers, `osi-server` schema, and the sync contract in the same change. Follow-up (fleet-level cloud health views, per the issue's "include in sync/cloud health views if useful") should be filed as a new osi-os + osi-server issue pair after this merges. |
| Migration idempotency | `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` in migration 0002 (and therefore in the seed — `verify-seed-replay` compares `sqlite_master` DDL text, so both files carry the identical statements) | Live Pis receive this DDL via `deploy.sh` **before** the migration-runner ledger is wired into deploy (runner is CI/verification-time only today, per the 2026-07-03 hardening plan roadmap). When ledger adoption happens later, `applyPending` can re-run 0002 as a clean no-op instead of failing on `table already exists`. |
| Live-Pi application path | `deploy.sh` `ensure_gateway_health_schema()` fetches `database/migrations/ordered/0002__gateway_health.sql` from the deploy HTTP server and `exec`s it via `/srv/node-red/node_modules/sqlite3` | The schema is *defined* once, in the runner's migration file (post-PR-#83 rule); deploy.sh executes that exact file, so there is no second hand-copied DDL to drift. Pis have no `sqlite3` CLI (only Silvan got one manually), so the node-sqlite3 heredoc pattern used by every existing `ensure_*_schema` function is the sanctioned mechanism. A guard refuses to run the file if its `-- risk:` header is not `additive`. |
| GUI | None in v1 | Acceptance criteria are SQL-queryability + docs. A `gateway_health` history card is already listed as a future group in the UX redesign spec — separate work. |

## Global Constraints

- **Boot-DDL freeze:** do NOT add anything to `sync-init-fn`. All schema goes through `database/migrations/ordered/` + seed + bundled DBs + the deploy.sh ensure function.
- **Migration file rules** (`lib/osi-migrate/migrations-loader.js`): filename `0002__gateway_health.sql` (`NNNN__slug.sql`, contiguous after 0001), first line exactly `-- risk: additive`.
- **Seed/replay fingerprint parity:** `scripts/verify-seed-replay.js` compares whitespace-normalized `sqlite_master` DDL between replay(0001+0002) and `seed-blank.sql`. The statements appended to the seed MUST be textually identical to the migration's statements (Task 2 generates the seed block from the migration file with `grep -vE '^\s*--'` — do not hand-retype).
- **Profile parity:** `conf/full_raspberrypi_bcm27xx_bcm2709` mirrors `conf/full_raspberrypi_bcm27xx_bcm2712` byte-for-byte for `files/usr/share/flows.json` and `files/usr/share/db/` — always `cp` after changing the 2712 copy. The minimal `bcm2708` full profile has no heartbeat flow (no `thermal_zone0` in its flows.json) — its bundled DB still gets the migration (schema-complete seeds), but no flow changes there.
- **Bundled DB safety:** bundled seed DBs in the repo are updated by *applying the migration*, never by regenerating or replacing them (they carry seeded calibration data). NEVER touch `/data/db/farming.db` on a live Pi outside `deploy.sh`.
- **CI (`.github/workflows/migrations.yml`) must stay green at every commit:** `node --test lib/osi-migrate/__tests__/*.test.js`, `check-sync-parity.test.js`, `restamp-fingerprints.test.js`, `verify-migrations.js`, `verify-seed-replay.js`, `verify-runtime-schema-parity.js`, `verify-devices-rebuild-fence.js`, `rehearse-devices-rebuild.test.js`. The new guard test is wired into this workflow only once it is fully green (Task 3).
- **Local gates before each commit:** `node scripts/verify-sync-flow.js` (chains `verify-db-schema-consistency.js`, `test-sync-history-schema.js`, `test-sync-history-worker.js`, `verify-profile-parity.js`) must end with `All parity checks passed.`; `node scripts/test-flows-wiring.js` must end with `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`.
- Verified-green baseline on main before starting (2026-07-05): `verify-migrations: OK (1 migrations)`, `verify-seed-replay: OK`, `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)`, `verify-sync-flow` → `All parity checks passed.`, `test-flows-wiring` → `PASS`.

## File Structure (all changes)

- Create: `scripts/test-gateway-health-persistence.js` — node:test guard (Task 1, extended Task 4)
- Create: `database/migrations/ordered/0002__gateway_health.sql` (Task 2)
- Modify: `database/seed-blank.sql` — append identical DDL (Task 2)
- Modify (binary): `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`, `conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`, `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db`, `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`, `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`, `database/farming.db`, `web/react-gui/farming.db` (Task 2)
- Modify: `scripts/verify-db-schema-consistency.js` — contract entries for the new tables/indexes (Task 2)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` + byte-identical `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` — 3 new nodes + 1 wire (Task 3)
- Modify: `.github/workflows/migrations.yml` — run the new guard (Task 3)
- Modify: `deploy.sh` — `ensure_gateway_health_schema` (Task 4)
- Modify: `docs/operations/edge-history-retention.md` — operator section (Task 6)
- Modify: `AGENTS.md` — persistence note + verification command (Task 6)

---

## The schema (canonical DDL — referenced by Tasks 2–5)

Two tables, no FKs, no triggers (deliberately: no sync outbox coupling, and `verify-runtime-schema-parity.js` compares the whole-flow trigger set against the seed, so adding no triggers keeps it trivially green).

`gateway_health_samples` — one row per heartbeat (60 s):

| column | type | meaning |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | row id |
| `gateway_device_eui` | TEXT NOT NULL | uppercase gateway EUI from the heartbeat payload |
| `sampled_at` | TEXT NOT NULL | heartbeat ISO-8601 UTC timestamp (`...T..:..:..sssZ`) |
| `cpu_temp_c` | REAL | SoC temperature, °C (NULL if the read failed) |
| `mem_percent` | REAL | used memory % |
| `load_1` / `load_5` / `load_15` | REAL | loadavg |
| `fan_value` | REAL | PWM 0–255 (NULL when `fan_available` is false) |
| `throttled` | INTEGER | raw `get_throttled` bitfield (NULL if sysfs absent) |
| `created_at` | TEXT NOT NULL DEFAULT strftime | insert time |

`gateway_health_hourly` — one row per gateway per closed UTC hour:
`(gateway_device_eui, hour_start)` PRIMARY KEY, `hour_start` formatted `YYYY-MM-DDTHH:00:00Z`, plus `sample_count`, `{cpu_temp_c,mem_percent,load_1,load_5,load_15,fan_value}_{min,mean,max}`, `throttled_max`, `computed_at`.

Note: `throttled_max` is an arithmetic `MAX()` of the raw bitfield integer, not a bitwise OR across the hour's samples — e.g. an hour containing one sample of `0x50000` and one of `0x40004` reports `0x50000` (the larger integer), not their bitwise union `0x50004`. Raw rows in `gateway_health_samples` retain each sample's full, uncombined bitfield for the raw retention window, so bit-level analysis ("was bit X set at any point") should query the raw table, not the hourly rollup.

---

### Task 1: Write the failing guard test (TDD)

**Files:** Create `scripts/test-gateway-health-persistence.js`

- [ ] **Step 1.1: Create the test file** with exactly this content:

```js
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
```

- [ ] **Step 1.2: Run it and confirm it is RED for the right reasons**

```bash
cd /home/phil/Repos/osi-os && node --test scripts/test-gateway-health-persistence.js 2>&1 | tail -5
```

Expected: `# tests 10`, `# pass 0`, `# fail 10` (every test fails — migration file absent, seed objects absent, flow nodes absent). Do NOT commit yet; this file is committed in Task 3 once green (it is intentionally not wired into CI until then).

---

### Task 2: Migration 0002 + seed + bundled DBs + schema contract

**Files:** Create `database/migrations/ordered/0002__gateway_health.sql`; modify `database/seed-blank.sql`, the 7 bundled `farming.db` copies, `scripts/verify-db-schema-consistency.js`.

- [ ] **Step 2.1: Create `database/migrations/ordered/0002__gateway_health.sql`** with exactly this content (first line MUST be the risk header; no comments inside CREATE statements — `sqlite_master` stores statement text verbatim and `verify-seed-replay` fingerprints it):

```sql
-- risk: additive
-- 0002: Persist aggregated gateway CPU health reporting (osi-os issue #68).
-- Raw 60s heartbeat samples + hourly min/mean/max rollups, pruned daily by the
-- Node-RED "Gateway Health Rollup" job (gateway-health-rollup-fn).
-- IF NOT EXISTS on purpose: live Pis receive this DDL via deploy.sh
-- (ensure_gateway_health_schema) before the migration-runner ledger is wired
-- into deploy; when ledger adoption happens later, re-running 0002 is a no-op.

CREATE TABLE IF NOT EXISTS gateway_health_samples (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_device_eui TEXT NOT NULL,
  sampled_at         TEXT NOT NULL,
  cpu_temp_c         REAL,
  mem_percent        REAL,
  load_1             REAL,
  load_5             REAL,
  load_15            REAL,
  fan_value          REAL,
  throttled          INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_gateway_health_samples_eui_time
  ON gateway_health_samples(gateway_device_eui, sampled_at);

CREATE INDEX IF NOT EXISTS idx_gateway_health_samples_time
  ON gateway_health_samples(sampled_at);

CREATE TABLE IF NOT EXISTS gateway_health_hourly (
  gateway_device_eui TEXT NOT NULL,
  hour_start         TEXT NOT NULL,
  sample_count       INTEGER NOT NULL DEFAULT 0,
  cpu_temp_c_min     REAL,
  cpu_temp_c_mean    REAL,
  cpu_temp_c_max     REAL,
  mem_percent_min    REAL,
  mem_percent_mean   REAL,
  mem_percent_max    REAL,
  load_1_min         REAL,
  load_1_mean        REAL,
  load_1_max         REAL,
  load_5_min         REAL,
  load_5_mean        REAL,
  load_5_max         REAL,
  load_15_min        REAL,
  load_15_mean       REAL,
  load_15_max        REAL,
  fan_value_min      REAL,
  fan_value_mean     REAL,
  fan_value_max      REAL,
  throttled_max      INTEGER,
  computed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (gateway_device_eui, hour_start)
);

CREATE INDEX IF NOT EXISTS idx_gateway_health_hourly_time
  ON gateway_health_hourly(hour_start);
```

- [ ] **Step 2.2: Append the identical statements to `database/seed-blank.sql`** (generated from the migration so the DDL text cannot drift — same trick the 0001 baseline used in reverse):

```bash
cd /home/phil/Repos/osi-os && {
  echo '';
  echo '-- Gateway health persistence (issue #68). Statements below are generated from';
  echo '-- database/migrations/ordered/0002__gateway_health.sql and MUST stay textually';
  echo '-- identical to it: scripts/verify-seed-replay.js compares sqlite_master fingerprints.';
  grep -vE '^\s*--' database/migrations/ordered/0002__gateway_health.sql;
} >> database/seed-blank.sql
```

- [ ] **Step 2.3: Verify the migration/seed pairing is green**

```bash
cd /home/phil/Repos/osi-os \
  && node scripts/verify-migrations.js \
  && node scripts/verify-seed-replay.js \
  && node scripts/verify-runtime-schema-parity.js \
  && node --test lib/osi-migrate/__tests__/*.test.js 2>&1 | tail -3
```

Expected: `verify-migrations: OK (2 migrations)`, `verify-seed-replay: OK`, `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)`, and the migrate test summary showing `# fail 0`.

- [ ] **Step 2.4: Apply the migration to the bundled seed databases** (apply to six copies, then `cp` the 2712 full copy over the 2709 mirror so profile parity stays byte-for-byte):

```bash
cd /home/phil/Repos/osi-os && for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do sqlite3 -bail "$db" < database/migrations/ordered/0002__gateway_health.sql && echo "OK $db"; done \
  && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  && echo "OK mirror copy"
```

Expected: six `OK <path>` lines + `OK mirror copy`.

- [ ] **Step 2.5: Extend the schema contract** in `scripts/verify-db-schema-consistency.js` so CI-adjacent tooling enforces the new tables in every bundled DB forever. Two edits:

(a) In the `schemaContract` object, immediately after the `chameleon_calibration_misses` entry (`  chameleon_calibration_misses: [\n    'array_id', 'last_tried', 'reason',\n  ],`), insert:

```js
  gateway_health_samples: [
    'id',
    'gateway_device_eui',
    'sampled_at',
    'cpu_temp_c',
    'mem_percent',
    'load_1',
    'load_5',
    'load_15',
    'fan_value',
    'throttled',
    'created_at',
  ],
  gateway_health_hourly: [
    'gateway_device_eui',
    'hour_start',
    'sample_count',
    'cpu_temp_c_min',
    'cpu_temp_c_mean',
    'cpu_temp_c_max',
    'mem_percent_min',
    'mem_percent_mean',
    'mem_percent_max',
    'load_1_min',
    'load_1_mean',
    'load_1_max',
    'load_5_min',
    'load_5_mean',
    'load_5_max',
    'load_15_min',
    'load_15_mean',
    'load_15_max',
    'fan_value_min',
    'fan_value_mean',
    'fan_value_max',
    'throttled_max',
    'computed_at',
  ],
```

(b) In the `requiredIndexes` object, immediately after the `chameleon_calibrations: ['idx_chameleon_calibrations_sensor_id'],` line, insert:

```js
  gateway_health_samples: ['idx_gateway_health_samples_eui_time', 'idx_gateway_health_samples_time'],
  gateway_health_hourly: ['idx_gateway_health_hourly_time'],
```

and in the `requiredIndexSqlFragments` object, immediately after the `idx_device_data_deveui_recorded_at` entry, insert:

```js
  idx_gateway_health_samples_eui_time: [
    'on gateway_health_samples(gateway_device_eui, sampled_at)',
  ],
  idx_gateway_health_samples_time: [
    'on gateway_health_samples(sampled_at)',
  ],
  idx_gateway_health_hourly_time: [
    'on gateway_health_hourly(hour_start)',
  ],
```

- [ ] **Step 2.6: Verify consistency + partial test progress**

```bash
cd /home/phil/Repos/osi-os \
  && node scripts/verify-db-schema-consistency.js && echo "CONSISTENCY OK" \
  && node --test scripts/test-gateway-health-persistence.js 2>&1 | tail -4
```

Expected: `CONSISTENCY OK`; guard summary `# tests 10`, `# pass 3`, `# fail 7` (the three schema tests pass; all flow tests still fail — that is correct at this point).

- [ ] **Step 2.7: Full local gate + commit**

```bash
cd /home/phil/Repos/osi-os && node scripts/verify-sync-flow.js 2>&1 | tail -2
```

Expected: `All parity checks passed.`

```bash
cd /home/phil/Repos/osi-os \
  && git add database/migrations/ordered/0002__gateway_health.sql database/seed-blank.sql \
     scripts/verify-db-schema-consistency.js \
     conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
     conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
     conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
     conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
     conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
     database/farming.db web/react-gui/farming.db \
  && git commit -m "feat(migrate): 0002 gateway health tables + seed/bundled-DB parity (#68)"
```

---

### Task 3: Flow nodes — self-sampling persist + daily rollup/retention (both profiles) + CI wiring

**Files:** Modify both `flows.json` copies (via script), `.github/workflows/migrations.yml`; commit `scripts/test-gateway-health-persistence.js`.

- [ ] **Step 3.1: Write the one-shot flows editor** to `/tmp/add-gateway-health-nodes.js` with exactly this content:

```js
#!/usr/bin/env node
// One-shot editor: adds gateway health sample-tick + persist + rollup-tick +
// rollup nodes to the canonical bcm2712 flows.json. Run once, then cp the
// file over the bcm2709 mirror. The Build Heartbeat node and its MQTT wiring
// are NOT touched by this script — the persist node self-samples via its own
// inject instead of teeing off the heartbeat.
'use strict';
const fs = require('fs');
const path = require('path');

const FLOW = path.resolve(
  process.cwd(),
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);

const PERSIST_FUNC = [
  "// Persist Gateway Health Sample (issue #68).",
  "// Self-samples on its own 60s inject (gateway-health-sample-tick) and writes",
  "// gateway_health_samples so outage analysis can query historical",
  "// CPU/memory/load/fan/throttle state per gateway+window. Read logic below",
  "// is copied verbatim from the Build Heartbeat node so DB values match what",
  "// the cloud heartbeat sees at the same cadence — Build Heartbeat itself and",
  "// its MQTT wiring are untouched.",
  "// Schema: database/migrations/ordered/0002__gateway_health.sql. If that",
  "// migration has not reached this Pi yet, skip quietly with a status hint.",
  "var INSERT_SQL = \"INSERT INTO gateway_health_samples (gateway_device_eui, sampled_at, cpu_temp_c, mem_percent, load_1, load_5, load_15, fan_value, throttled) VALUES (?,?,?,?,?,?,?,?,?)\";",
  "",
  "function findFanControl(fs) {",
  "  try {",
  "    var dirs = fs.readdirSync('/sys/class/hwmon');",
  "    for (var i = 0; i < dirs.length; i++) {",
  "      try {",
  "        var n = fs.readFileSync('/sys/class/hwmon/' + dirs[i] + '/name', 'utf8').trim();",
  "        if (n === 'pwmfan') return { type: 'hwmon', path: '/sys/class/hwmon/' + dirs[i] };",
  "      } catch(e) {}",
  "    }",
  "  } catch(e) {}",
  "  try {",
  "    fs.accessSync('/sys/class/pwm/pwmchip2');",
  "    return { type: 'pwm', path: '/sys/class/pwm/pwmchip2' };",
  "  } catch(e) {}",
  "  return null;",
  "}",
  "var eui = env.get('DEVICE_EUI') || 'UNKNOWN';",
  "",
  "var os = global.get('os');",
  "var fs = global.get('fs');",
  "var cpuTemp = null, memPercent = null, load1 = null, load5 = null, load15 = null, fanValue = null;",
  "var fanAvailable = false;",
  "",
  "try { cpuTemp = Math.round(parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim()) / 100) / 10; } catch(e) {}",
  "try {",
  "    var tm = os.totalmem(), fm = os.freemem();",
  "    memPercent = Math.round(((tm - fm) / tm) * 100);",
  "} catch(e) {}",
  "try {",
  "    var la = os.loadavg();",
  "    load1 = Math.round(la[0] * 100) / 100;",
  "    load5 = Math.round(la[1] * 100) / 100;",
  "    load15 = Math.round(la[2] * 100) / 100;",
  "} catch(e) {}",
  "try {",
  "    var fanCtrl = findFanControl(fs);",
  "    if (fanCtrl) {",
  "        if (fanCtrl.type === 'hwmon') {",
  "            var pwm1Val = parseInt(fs.readFileSync(fanCtrl.path + '/pwm1', 'utf8').trim()) || 0;",
  "            fanAvailable = true;",
  "            fanValue = pwm1Val;",
  "        } else {",
  "            var pwmChan = fanCtrl.path + '/pwm3';",
  "            var period = parseInt(fs.readFileSync(pwmChan + '/period', 'utf8').trim());",
  "            var duty   = parseInt(fs.readFileSync(pwmChan + '/duty_cycle', 'utf8').trim());",
  "            fanAvailable = true;",
  "            fanValue = Math.round((1 - duty / period) * 255);",
  "        }",
  "    }",
  "} catch(e) {}",
  "",
  "// Best-effort Raspberry Pi firmware throttle bitfield. Plain sysfs read (no",
  "// subprocess spawn every 60s). NULL when the sysfs node is absent.",
  "var throttled = null;",
  "try {",
  "    var rawThrottled = fs.readFileSync('/sys/devices/platform/soc/soc:firmware/get_throttled', 'utf8').trim();",
  "    var parsedThrottled = parseInt(rawThrottled.replace(/^0x/i, ''), 16);",
  "    if (!isNaN(parsedThrottled)) { throttled = parsedThrottled; }",
  "} catch (e) {}",
  "",
  "var sampled_at = new Date().toISOString();",
  "var params = [",
  "    eui,",
  "    sampled_at,",
  "    cpuTemp,",
  "    memPercent,",
  "    load1,",
  "    load5,",
  "    load15,",
  "    fanAvailable ? fanValue : null,",
  "    throttled",
  "];",
  "",
  "return (async () => {",
  "    const _db = new osiDb.Database('/data/db/farming.db');",
  "    const run = (sql, p) => new Promise((res, rej) => _db.run(sql, p || [], (e) => e ? rej(e) : res()));",
  "    const close = () => new Promise((res) => _db.close(() => res()));",
  "    try {",
  "        await run(INSERT_SQL, params);",
  "        await close();",
  "        context.set('lastError', null);",
  "        node.status({ fill: 'green', shape: 'dot', text: 'sample ' + String(sampled_at).slice(11, 19) + 'Z' });",
  "    } catch (e) {",
  "        try { await close(); } catch (_) {}",
  "        var errText = String(e.message || e);",
  "        if (/no such table/i.test(errText)) {",
  "            node.status({ fill: 'yellow', shape: 'ring', text: 'gateway_health_samples missing (run deploy migration)' });",
  "        } else {",
  "            node.status({ fill: 'red', shape: 'ring', text: errText.slice(0, 40) });",
  "            if (context.get('lastError') !== errText) {",
  "                context.set('lastError', errText);",
  "                node.warn('Persist Gateway Health failed: ' + errText);",
  "            }",
  "        }",
  "    }",
  "    return null;",
  "})();",
].join('\n');

const ROLLUP_FUNC = [
  "// Gateway Health Rollup + Retention (issue #68). Daily at 02:10 via",
  "// gateway-health-rollup-tick. Idempotent: re-aggregates every CLOSED hour",
  "// still present in gateway_health_samples with INSERT OR REPLACE, so missed",
  "// nights self-heal as long as raw retention (default 14d) exceeds the gap.",
  "// Then prunes raw samples and old hourly rollups.",
  "var ROLLUP_SQL = \"INSERT OR REPLACE INTO gateway_health_hourly (gateway_device_eui, hour_start, sample_count, cpu_temp_c_min, cpu_temp_c_mean, cpu_temp_c_max, mem_percent_min, mem_percent_mean, mem_percent_max, load_1_min, load_1_mean, load_1_max, load_5_min, load_5_mean, load_5_max, load_15_min, load_15_mean, load_15_max, fan_value_min, fan_value_mean, fan_value_max, throttled_max, computed_at) SELECT gateway_device_eui, strftime('%Y-%m-%dT%H:00:00Z', sampled_at), COUNT(*), MIN(cpu_temp_c), AVG(cpu_temp_c), MAX(cpu_temp_c), MIN(mem_percent), AVG(mem_percent), MAX(mem_percent), MIN(load_1), AVG(load_1), MAX(load_1), MIN(load_5), AVG(load_5), MAX(load_5), MIN(load_15), AVG(load_15), MAX(load_15), MIN(fan_value), AVG(fan_value), MAX(fan_value), MAX(throttled), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM gateway_health_samples WHERE sampled_at < strftime('%Y-%m-%dT%H:00:00.000Z','now') GROUP BY gateway_device_eui, strftime('%Y-%m-%dT%H:00:00Z', sampled_at)\";",
  "var rawDays = parseInt(String(env.get('OSI_HEALTH_RAW_RETENTION_DAYS') || '14').trim(), 10);",
  "if (!isFinite(rawDays) || rawDays < 1) { rawDays = 14; }",
  "var hourlyDays = parseInt(String(env.get('OSI_HEALTH_HOURLY_RETENTION_DAYS') || '365').trim(), 10);",
  "if (!isFinite(hourlyDays) || hourlyDays < 1) { hourlyDays = 365; }",
  "var rawCutoff = new Date(Math.floor((Date.now() - rawDays * 86400000) / 3600000) * 3600000).toISOString();",
  "var hourlyCutoff = new Date(Date.now() - hourlyDays * 86400000).toISOString();",
  "",
  "return (async () => {",
  "    const _db = new osiDb.Database('/data/db/farming.db');",
  "    const q = (sql, p) => new Promise((res, rej) => _db.all(sql, p || [], (e, r) => e ? rej(e) : res(r || [])));",
  "    const run = (sql, p) => new Promise((res, rej) => _db.run(sql, p || [], (e) => e ? rej(e) : res()));",
  "    const close = () => new Promise((res) => _db.close(() => res()));",
  "    try {",
  "        await run(ROLLUP_SQL);",
  "        const staleRaw = await q('SELECT COUNT(*) AS n FROM gateway_health_samples WHERE sampled_at < ?', [rawCutoff]);",
  "        const rawPruned = Number((staleRaw[0] || {}).n || 0);",
  "        if (rawPruned > 0) {",
  "            await run('DELETE FROM gateway_health_samples WHERE sampled_at < ?', [rawCutoff]);",
  "        }",
  "        const staleHourly = await q('SELECT COUNT(*) AS n FROM gateway_health_hourly WHERE hour_start < ?', [hourlyCutoff]);",
  "        const hourlyPruned = Number((staleHourly[0] || {}).n || 0);",
  "        if (hourlyPruned > 0) {",
  "            await run('DELETE FROM gateway_health_hourly WHERE hour_start < ?', [hourlyCutoff]);",
  "        }",
  "        if (rawPruned > 0 || hourlyPruned > 0) {",
  "            try { await run('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}",
  "        }",
  "        const totals = await q('SELECT (SELECT COUNT(*) FROM gateway_health_samples) AS raw_rows, (SELECT COUNT(*) FROM gateway_health_hourly) AS hourly_rows');",
  "        await close();",
  "        const t = totals[0] || {};",
  "        node.status({ fill: 'green', shape: 'dot', text: 'raw ' + (t.raw_rows || 0) + ' / hourly ' + (t.hourly_rows || 0) + ', pruned ' + rawPruned + '+' + hourlyPruned });",
  "        msg.payload = {",
  "            rawRows: Number(t.raw_rows || 0),",
  "            hourlyRows: Number(t.hourly_rows || 0),",
  "            rawPruned: rawPruned,",
  "            hourlyPruned: hourlyPruned,",
  "            rawCutoff: rawCutoff,",
  "            hourlyCutoff: hourlyCutoff",
  "        };",
  "        return msg;",
  "    } catch (e) {",
  "        try { await close(); } catch (_) {}",
  "        var errText = String(e.message || e);",
  "        if (/no such table/i.test(errText)) {",
  "            node.status({ fill: 'yellow', shape: 'ring', text: 'gateway_health tables missing (run deploy migration)' });",
  "            return null;",
  "        }",
  "        node.warn('Gateway Health Rollup failed: ' + errText);",
  "        node.status({ fill: 'red', shape: 'ring', text: errText.slice(0, 40) });",
  "        return null;",
  "    }",
  "})();",
].join('\n');

const sampleTickNode = {
  id: 'gateway-health-sample-tick',
  type: 'inject',
  z: '93b1537a596e0e6d',
  name: 'Gateway Health Sample Tick',
  props: [{ p: 'payload' }],
  repeat: '60',
  crontab: '',
  once: true,
  onceDelay: '5',
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 170,
  y: 1180,
  wires: [['gateway-health-persist-fn']],
};

const persistNode = {
  id: 'gateway-health-persist-fn',
  type: 'function',
  z: '93b1537a596e0e6d',
  name: 'Persist Gateway Health',
  func: PERSIST_FUNC,
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [{ var: 'osiDb', module: 'osi-db-helper' }],
  x: 430,
  y: 1180,
  wires: [[]],
};

const tickNode = {
  id: 'gateway-health-rollup-tick',
  type: 'inject',
  z: '93b1537a596e0e6d',
  name: 'Gateway Health Rollup Tick',
  props: [{ p: 'payload' }],
  repeat: '',
  crontab: '10 2 * * *',
  once: false,
  onceDelay: 0.1,
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 170,
  y: 1240,
  wires: [['gateway-health-rollup-fn']],
};

const rollupNode = {
  id: 'gateway-health-rollup-fn',
  type: 'function',
  z: '93b1537a596e0e6d',
  name: 'Gateway Health Rollup',
  func: ROLLUP_FUNC,
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [{ var: 'osiDb', module: 'osi-db-helper' }],
  x: 430,
  y: 1240,
  wires: [[]],
};

const flows = JSON.parse(fs.readFileSync(FLOW, 'utf8'));
if (flows.some((n) => n.id === 'gateway-health-persist-fn')) {
  console.error('ABORT: gateway-health-persist-fn already present');
  process.exit(1);
}
if (flows.some((n) => n.id === 'gateway-health-sample-tick')) {
  console.error('ABORT: gateway-health-sample-tick already present');
  process.exit(1);
}
// The Build Heartbeat node is intentionally NOT read or modified by this
// script: the persist node self-samples on its own inject instead of teeing
// off it.

const pruneIdx = flows.findIndex((n) => n.id === 'prune-sync-outbox');
if (pruneIdx === -1) { console.error('ABORT: prune-sync-outbox not found'); process.exit(1); }
flows.splice(pruneIdx + 1, 0, sampleTickNode, persistNode, tickNode, rollupNode);

fs.writeFileSync(FLOW, JSON.stringify(flows, null, 2) + '\n');
console.log('OK: 4 nodes added (sample tick, persist, rollup tick, rollup); Build Heartbeat untouched');
```

- [ ] **Step 3.2: Run it, mirror to bcm2709, clean up**

```bash
node /tmp/add-gateway-health-nodes.js \
  && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  && rm /tmp/add-gateway-health-nodes.js && echo MIRRORED
```

Expected: `OK: 4 nodes added (sample tick, persist, rollup tick, rollup); Build Heartbeat untouched` then `MIRRORED`. (Run this from the worktree root — the `cp` targets are relative to `cwd`.)

- [ ] **Step 3.3: Guard test fully green**

```bash
cd /home/phil/Repos/osi-os && node --test scripts/test-gateway-health-persistence.js 2>&1 | tail -4
```

Expected: `# tests 10`, `# pass 10`, `# fail 0`.

- [ ] **Step 3.4: Full local gates**

```bash
cd /home/phil/Repos/osi-os \
  && node scripts/test-flows-wiring.js | tail -1 \
  && scripts/check-mqtt-topics.sh \
  && node scripts/verify-runtime-schema-parity.js \
  && node scripts/verify-sync-flow.js 2>&1 | tail -1
```

Expected, in order: `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`; check-mqtt-topics exits 0 (no MQTT IN nodes were added); `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)`; `All parity checks passed.`

- [ ] **Step 3.5: Wire the guard into CI.** In `.github/workflows/migrations.yml`, after the line `      - run: node --test scripts/rehearse-devices-rebuild.test.js`, append:

```yaml
      - run: node --test scripts/test-gateway-health-persistence.js
```

- [ ] **Step 3.6: Commit**

```bash
cd /home/phil/Repos/osi-os \
  && git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
     conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
     scripts/test-gateway-health-persistence.js .github/workflows/migrations.yml \
  && git commit -m "feat(flows): persist heartbeat gateway health + daily rollup/retention (#68)"
```

---

### Task 4: deploy.sh — apply migration 0002 on live Pis

**Files:** Modify `deploy.sh`; extend `scripts/test-gateway-health-persistence.js`.

- [ ] **Step 4.1: Add the ensure function to `deploy.sh`.** Insert the following block after the closing `}` of `ensure_chameleon_schema()` (currently the `NODE`-terminated function ending around line 463, directly before the `echo "=== OSI OS Deploy ==="` line):

```sh
ensure_gateway_health_schema() {
    echo "--- Live gateway health schema (ordered migration 0002) ---"
    if [ ! -e "$DB_PATH" ]; then
        echo "SKIP: no live database at $DB_PATH"
        return 0
    fi
    fetch "database/migrations/ordered/0002__gateway_health.sql" "$TMP_DIR/0002__gateway_health.sql"
    OSI_MIGRATION_SQL="$TMP_DIR/0002__gateway_health.sql" node <<'NODE'
const fs = require('fs');
const dbPath = '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
  console.log('SKIP: no live database at ' + dbPath);
  process.exit(0);
}
// Single source of DDL truth: execute the ordered-migration file itself.
// Guard: only additive migrations may be applied through this deploy hook.
const sql = fs.readFileSync(process.env.OSI_MIGRATION_SQL, 'utf8');
if (!/^--\s*risk:\s*additive\s*(\r?\n|$)/.test(sql)) {
  console.error('ERROR: refusing to apply a non-additive migration via deploy repair');
  process.exit(1);
}
const sqlite3 = require('/srv/node-red/node_modules/sqlite3');
const db = new sqlite3.Database(dbPath);
function run(s) { return new Promise((resolve, reject) => db.run(s, (err) => err ? reject(err) : resolve())); }
function exec(s) { return new Promise((resolve, reject) => db.exec(s, (err) => err ? reject(err) : resolve())); }
function all(s) { return new Promise((resolve, reject) => db.all(s, (err, rows) => err ? reject(err) : resolve(rows || []))); }
(async () => {
  await run('PRAGMA busy_timeout=5000');
  await exec(sql);
  const tables = new Set((await all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  for (const t of ['gateway_health_samples', 'gateway_health_hourly']) {
    if (!tables.has(t)) throw new Error('gateway health table still missing after deploy repair: ' + t);
  }
  console.log('OK');
  db.close();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  db.close();
  process.exit(1);
});
NODE
}
```

- [ ] **Step 4.2: Invoke it.** In the deploy sequence, change:

```sh
ensure_dendro_schema
ensure_zone_irrigation_calibration_schema
ensure_analysis_views_schema
ensure_chameleon_schema
```

to:

```sh
ensure_dendro_schema
ensure_zone_irrigation_calibration_schema
ensure_analysis_views_schema
ensure_chameleon_schema
ensure_gateway_health_schema
```

(This runs after `npm install` — so `/srv/node-red/node_modules/sqlite3` exists — and before the Node-RED restart the operator performs after deploy, so the table is present before the persist node first fires.)

- [ ] **Step 4.3: Append the deploy guard test.** Add to the end of `scripts/test-gateway-health-persistence.js`:

```js
test('deploy.sh applies migration 0002 to live DBs (after chameleon repair, before restart)', () => {
  const text = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
  assert.match(text, /ensure_gateway_health_schema\(\)/);
  assert.match(text, /database\/migrations\/ordered\/0002__gateway_health\.sql/);
  assert.match(text, /refusing to apply a non-additive migration/);
  const callIdx = text.lastIndexOf('\nensure_gateway_health_schema');
  const chameleonCallIdx = text.lastIndexOf('\nensure_chameleon_schema');
  assert.ok(chameleonCallIdx > -1, 'ensure_chameleon_schema call not found');
  assert.ok(callIdx > chameleonCallIdx,
    'ensure_gateway_health_schema must be invoked after ensure_chameleon_schema');
});
```

- [ ] **Step 4.4: Verify + commit**

```bash
cd /home/phil/Repos/osi-os \
  && sh -n deploy.sh && echo "SYNTAX OK" \
  && node --test scripts/test-gateway-health-persistence.js 2>&1 | tail -4 \
  && node scripts/verify-sync-flow.js 2>&1 | tail -1
```

Expected: `SYNTAX OK`; `# tests 11`, `# pass 11`, `# fail 0`; `All parity checks passed.` (`verify-sync-flow.js` parses `deploy.sh` for its own invariants — it must stay green.)

```bash
cd /home/phil/Repos/osi-os \
  && git add deploy.sh scripts/test-gateway-health-persistence.js \
  && git commit -m "feat(deploy): apply gateway health migration 0002 on live Pis (#68)"
```

---

### Task 5: End-to-end SQLite smoke test (no commit — verification only)

This rehearses exactly what an operator will run during an outage analysis, against a temp DB built from the seed, using the **shipped** rollup SQL extracted from `flows.json`.

- [ ] **Steps 5.1–5.4: Build a temp DB, roll up, query, and prove retention — one shell session so `$SMOKE` survives across all four sub-steps**

```bash
cd /home/phil/Repos/osi-os \
  && SMOKE=$(mktemp -d) \
  && echo "SMOKE=$SMOKE" \
  \
  && echo "--- Step 5.1: build temp DB + insert outage-shaped fixture ---" \
  && sqlite3 -bail "$SMOKE/health.db" < database/seed-blank.sql \
  && sqlite3 -bail "$SMOKE/health.db" <<'SQL'
INSERT INTO gateway_health_samples (gateway_device_eui, sampled_at, cpu_temp_c, mem_percent, load_1, load_5, load_15, fan_value, throttled) VALUES
 ('0016C001F11766E7','2026-06-28T09:00:12.000Z',61.2,38,0.42,0.31,0.22,120,0),
 ('0016C001F11766E7','2026-06-28T09:01:12.000Z',72.8,39,1.90,0.80,0.35,200,262148),
 ('0016C001F11766E7','2026-06-28T09:02:12.000Z',66.1,40,0.95,0.60,0.30,160,262144),
 ('0016C001F11766E7','2026-06-28T10:00:12.000Z',55.0,36,0.20,0.25,0.20,90,0);
SQL
echo "--- Step 5.2: run the shipped rollup SQL ---"
node -e "
const fs = require('fs');
const flows = JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json', 'utf8'));
const fn = flows.find((n) => n.id === 'gateway-health-rollup-fn');
const m = /var ROLLUP_SQL = \"([^\"]+)\";/.exec(fn.func);
if (!m) { console.error('ROLLUP_SQL not found'); process.exit(1); }
process.stdout.write(m[1] + ';');
" > "$SMOKE/rollup.sql" && sqlite3 -bail "$SMOKE/health.db" < "$SMOKE/rollup.sql" && echo "ROLLUP OK"

echo "--- Step 5.3: run the documented operator query ---"
sqlite3 -header -column "$SMOKE/health.db" "
SELECT hour_start, sample_count,
       ROUND(cpu_temp_c_min,1)  AS t_min,
       ROUND(cpu_temp_c_mean,1) AS t_mean,
       ROUND(cpu_temp_c_max,1)  AS t_max,
       throttled_max
FROM gateway_health_hourly
WHERE gateway_device_eui = '0016C001F11766E7'
  AND hour_start >= '2026-06-28T00:00:00Z' AND hour_start < '2026-06-29T00:00:00Z'
ORDER BY hour_start;"

echo "--- Step 5.4: prove retention keeps rollups after raw prune ---"
sqlite3 "$SMOKE/health.db" "
DELETE FROM gateway_health_samples WHERE sampled_at < '2026-06-29T00:00:00.000Z';
SELECT (SELECT COUNT(*) FROM gateway_health_samples) AS raw_left,
       (SELECT COUNT(*) FROM gateway_health_hourly) AS hourly_left;" \
&& rm -rf "$SMOKE"
```

Expected output for Step 5.2: `ROLLUP OK`. Expected output for Step 5.3:

```
hour_start            sample_count  t_min  t_mean  t_max  throttled_max
--------------------  ------------  -----  ------  -----  -------------
2026-06-28T09:00:00Z  3             61.2   66.7    72.8   262148
2026-06-28T10:00:00Z  1             55.0   55.0    55.0   0
```

(262148 = 0x40004 = "throttling has occurred since boot" + "currently throttled".) Expected output for Step 5.4: `0|2` — raw pruned, both hourly rollups survive.

---

### Task 6: Operator documentation + AGENTS.md

**Files:** Modify `docs/operations/edge-history-retention.md`, `AGENTS.md`.

- [ ] **Step 6.1: Append this section to `docs/operations/edge-history-retention.md`:**

```markdown

## Gateway health telemetry (CPU / memory / load / fan / throttling)

Since ordered migration `database/migrations/ordered/0002__gateway_health.sql`
(2026-07, osi-os #68), every gateway persists its own 60 s heartbeat locally in
`/data/db/farming.db`. This closes the gap found during the 2026-06-28 kaba100
Chameleon-1 I2C outage analysis: before this, CPU temperature/load/fan state
was live MQTT telemetry only, so "was the Pi throttling when the gap started?"
could not be answered from the edge database.

### What is stored

| Table | Grain | Retention (default) | Written by |
|---|---|---|---|
| `gateway_health_samples` | 1 row / 60 s heartbeat | 14 days (`OSI_HEALTH_RAW_RETENTION_DAYS`) | `Persist Gateway Health` node, own 60 s inject `gateway-health-sample-tick` |
| `gateway_health_hourly` | 1 row / gateway / closed UTC hour, `min/mean/max` + `sample_count` | 365 days (`OSI_HEALTH_HOURLY_RETENTION_DAYS`) | `Gateway Health Rollup` node, daily at 02:10 |

Columns per sample: `gateway_device_eui`, `sampled_at` (ISO UTC), `cpu_temp_c`,
`mem_percent`, `load_1/5/15`, `fan_value` (PWM 0–255, NULL when no fan), and
`throttled` — the raw Raspberry Pi firmware `get_throttled` bitfield read from
`/sys/devices/platform/soc/soc:firmware/get_throttled` (NULL when the kernel
does not expose it). Bits: `0x1` under-voltage now, `0x2` ARM frequency capped
now, `0x4` currently throttled, `0x8` soft temperature limit now; the same bits
shifted left 16 (`0x10000`…`0x80000`) mean "has occurred since boot".

The rollup job is idempotent (`INSERT OR REPLACE` over every closed hour still
inside the raw window), so nights where the Pi was powered off self-heal on the
next run. A **gap in `gateway_health_samples` rows is itself evidence** that
Node-RED (or the Pi) was down for that window. This data is local-only: it is
NOT synced to OSI Server in v1 (the cloud already receives live heartbeats).

### How to query it

Pis do not ship the `sqlite3` CLI. Either copy the DB off the Pi
(`scripts/download-farming-db.sh`) and query locally, or run node on the Pi:

```
node -e "const s=require('/srv/node-red/node_modules/sqlite3');const d=new s.Database('/data/db/farming.db');d.all('SELECT COUNT(*) AS n, MAX(sampled_at) AS last FROM gateway_health_samples',(e,r)=>{console.log(e?String(e):JSON.stringify(r));d.close();});"
```

Hourly overview for an outage window (per gateway + time window):

```sql
SELECT hour_start, sample_count,
       ROUND(cpu_temp_c_max,1)  AS cpu_max_c,
       ROUND(mem_percent_max,0) AS mem_max_pct,
       ROUND(load_1_max,2)      AS load1_max,
       fan_value_max, throttled_max
FROM gateway_health_hourly
WHERE gateway_device_eui = '0016C001F11766E7'
  AND hour_start >= '2026-06-27T00:00:00Z'
  AND hour_start <  '2026-06-29T00:00:00Z'
ORDER BY hour_start;
```

Minute-level detail around a suspected gap (raw window, last 14 days):

```sql
SELECT sampled_at, cpu_temp_c, mem_percent, load_1, fan_value, throttled
FROM gateway_health_samples
WHERE gateway_device_eui = '0016C001F11766E7'
  AND sampled_at >= '2026-06-28T08:30:00Z'
  AND sampled_at <  '2026-06-28T10:30:00Z'
ORDER BY sampled_at;
```

"Was it throttling?" summary for a window:

```sql
SELECT COUNT(*) AS samples,
       SUM(CASE WHEN (throttled & 0x4) != 0 THEN 1 ELSE 0 END) AS throttled_now_samples,
       MAX(cpu_temp_c) AS max_temp_c
FROM gateway_health_samples
WHERE gateway_device_eui = '0016C001F11766E7'
  AND sampled_at >= '2026-06-28T08:00:00Z'
  AND sampled_at <  '2026-06-28T12:00:00Z';
```

Heartbeat/sampling gaps > 5 min (downtime candidates):

```sql
SELECT prev_at, sampled_at,
       ROUND((julianday(sampled_at) - julianday(prev_at)) * 1440, 1) AS gap_min
FROM (SELECT sampled_at, LAG(sampled_at) OVER (ORDER BY sampled_at) AS prev_at
      FROM gateway_health_samples
      WHERE gateway_device_eui = '0016C001F11766E7')
WHERE prev_at IS NOT NULL
  AND (julianday(sampled_at) - julianday(prev_at)) * 1440 > 5
ORDER BY sampled_at;
```

### Rollout to a live Pi

`deploy.sh` applies migration 0002 automatically (`ensure_gateway_health_schema`,
which fetches and executes the migration file — additive-only, idempotent)
before the operator restarts Node-RED. Post-deploy check: run the node
one-liner above ~2 minutes after `/etc/init.d/node-red restart` and expect
`n >= 1` with a fresh `last` timestamp. The first hourly rollups appear after
the next 02:10 tick (or trigger `Gateway Health Rollup Tick` manually in the
Node-RED editor).
```

- [ ] **Step 6.2: Update `AGENTS.md`.** (a) In the MQTT topics section, directly after the paragraph beginning `**Fan telemetry/control:**` (ends `…direct writes can fail with \`EBUSY\`.`), insert:

```markdown

**Gateway health persistence:** the same CPU/memory/load/fan facts the 60 s heartbeat reports are also persisted locally (osi-os #68) via its own 60s inject `gateway-health-sample-tick`: `gateway_health_samples` (raw, default 14 d) and `gateway_health_hourly` (min/mean/max rollups, default 365 d) in `/data/db/farming.db`, written by the `Persist Gateway Health` node and rolled up + pruned daily at 02:10 by `Gateway Health Rollup`. Includes the best-effort `get_throttled` bitfield. Schema: `database/migrations/ordered/0002__gateway_health.sql`; local-only (not cloud-synced) in v1. Operator guide: [docs/operations/edge-history-retention.md](docs/operations/edge-history-retention.md).
```

(b) In the `## Verification commands` code block, after the `scripts/check-mqtt-topics.sh` line, add:

```
node --test scripts/test-gateway-health-persistence.js  # gateway health persistence guard
```

- [ ] **Step 6.3: Final full gate + commit**

```bash
cd /home/phil/Repos/osi-os \
  && node scripts/verify-migrations.js \
  && node scripts/verify-seed-replay.js \
  && node scripts/verify-runtime-schema-parity.js \
  && node scripts/verify-devices-rebuild-fence.js \
  && node --test lib/osi-migrate/__tests__/*.test.js 2>&1 | tail -1 \
  && node --test scripts/test-gateway-health-persistence.js 2>&1 | tail -1 \
  && node scripts/test-flows-wiring.js | tail -1 \
  && node scripts/verify-sync-flow.js 2>&1 | tail -1 \
  && git diff --check && echo "ALL GATES GREEN"
```

Expected: `verify-migrations: OK (2 migrations)`, `verify-seed-replay: OK`, parity OK, fence OK, both test summaries with `fail 0` (the tails show `# fail 0` lines), `PASS: STREGA wiring…`, `All parity checks passed.`, `ALL GATES GREEN`.

```bash
cd /home/phil/Repos/osi-os \
  && git add docs/operations/edge-history-retention.md AGENTS.md \
  && git commit -m "docs(operations): gateway health telemetry operator guide (#68)"
```

---

## Live rollout runbook (after merge — not part of the repo change)

Per-Pi, standard safe deploy flow (see MEMORY/AGENTS deploy guardrails):

1. `cd /home/phil/Repos/osi-os && python3 -m http.server 9876 --bind 127.0.0.1` (repo root).
2. `ssh -R 9876:localhost:9876 root@<pi> 'curl -fsS http://localhost:9876/deploy.sh | sh'` — watch for the new line `--- Live gateway health schema (ordered migration 0002) ---` followed by `OK`.
3. `ssh root@<pi> '/etc/init.d/node-red restart'`.
4. After ~2 min: run the node one-liner from the operator doc; expect `[{"n":<≥1>,"last":"<fresh ISO>"}]`.
5. Optional: check `cat /sys/devices/platform/soc/soc:firmware/get_throttled` on the Pi — if the file is absent, `throttled` will be NULL (documented, acceptable).
6. Standard post-checks (GUI hash, `farming.db` preserved, `:1880/gui` up) still apply. `farming.db` is never overwritten — 0002 is additive and idempotent.

Order Pis: kaba100 (demo) → Silvan (demo) → Uganda (production).

## Out of scope / follow-ups (file after merge)

1. **Cloud fleet health views** (issue #68 "include in sync/cloud health views if useful"): would need outbox events or a history-sync table registration + osi-server schema — file as an osi-os + osi-server issue pair.
2. **`gateway_health` history card in the GUI** — already reserved as a channel group in `docs/ux/history-data-visualization-redesign-spec.md`.
3. **Migration-runner ledger adoption on live Pis** (stamp 0001/0002 + fingerprints, switch deploy.sh from `ensure_*` heredocs to `applyPending`) — existing roadmap item from the 2026-07-03 hardening plan; 0002's `IF NOT EXISTS` was chosen specifically so that adoption can re-run it safely.

## Self-Review

**Acceptance criteria coverage (issue #68):**
- *Persists locally, not only live MQTT* → Task 3 persist node + Task 2 schema.
- *No unbounded high-frequency growth (rollups/retention)* → 14 d raw cap + 365 d hourly cap, pruned daily (Task 3 rollup node); worst case ≈ 20k + 8.8k rows ≈ ~3.5 MB.
- *Queryable per gateway + time window from SQLite* → both tables keyed `(gateway_device_eui, time)` with matching indexes; operator queries in Task 6 and rehearsed with expected output in Task 5.
- *Usable for outage analysis* → raw minute window covers "what happened around the gap", `throttled` bitfield answers the kaba100 throttling question, and sample gaps expose downtime; smoke test reproduces exactly this workflow.
- *Documented for operators* → Task 6 section in `docs/operations/edge-history-retention.md`, referencing the 2026-06-28 kaba100 Chameleon-1 I2C outage analysis as plain text (that doc is untracked upstream, so no markdown link is used), plus AGENTS.md pointer.

**Repo-constraint compliance:** schema only via `database/migrations/ordered/` + seed + bundled DBs (boot `sync-init-fn` untouched); `-- risk: additive` header matches `RISK_RE`; filename matches `NAME_RE` and is contiguous (verify-migrations); seed block is *generated* from the migration so `verify-seed-replay` fingerprints match; no new triggers/CHECKs so `verify-runtime-schema-parity` is unaffected; both flows.json copies and both full-profile DB copies are byte-identical (`cp`), keeping `verify-profile-parity`/`verify-sync-flow` green; new function nodes declare `osiDb` libs and close handles (`test-flows-wiring` audits); the `var os/fs = global.get(...)` local-bind pattern in the persist node satisfies `verify-sync-flow`'s guarded-module check without adding `os`/`fs` to `libs`; no MQTT IN nodes added (`check-mqtt-topics` unaffected); `Build Heartbeat` (`062a0f9bf66d9789`) and its MQTT wiring (`d769e9face3844d5`) are read-only reference material for the persist node's logic and are never written by the editor script; CI (`migrations.yml`) gains one step only after the guard is green.

**Ordering/type consistency:** Task 1's test consumes the migration path (Task 2), node ids/`INSERT_SQL`/`ROLLUP_SQL` literals (Task 3), and deploy.sh markers (Task 4) — execute tasks in order; every intermediate commit keeps all *committed* gates green (the guard test is only committed and CI-wired in Task 3 when fully green). The `var NAME = "…";` single-line string convention in both function nodes is load-bearing: the guard test and the Task 5 smoke test extract and execute the shipped SQL from `flows.json`, so implementers must not reformat those two lines.

**Placeholder scan:** no TODOs/ellipses/stub code; every step has complete code or an exact command with expected output; verified all referenced node ids (`gateway-health-sample-tick`, `gateway-health-persist-fn`, `gateway-health-rollup-tick`, `gateway-health-rollup-fn`, `93b1537a596e0e6d`, `prune-sync-outbox`; `062a0f9bf66d9789`/`d769e9face3844d5` referenced only as untouched reference nodes) and file paths against the working tree on 2026-07-05.
