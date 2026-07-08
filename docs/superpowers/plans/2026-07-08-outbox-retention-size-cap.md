# `sync_outbox` Retention + Size Cap (item 1.A5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes (learned from prior plans):** (1) work inside a feature worktree/branch (`feat/1A5-outbox-size-cap`), not the root `main` checkout; (2) after every edit to `conf/full_raspberrypi_bcm27xx_bcm2712/files/.../flows.json`, mirror it byte-for-byte into the `bcm2709` copy with `cp` — `verify-profile-parity.js` (chained from `verify-sync-flow.js`) hashes the mirror; (3) `flows.json` is exactly `JSON.stringify(flows, null, 2) + '\n'` — edit it with a one-shot Node script, never by hand; (4) any function node touching `osiDb` must keep `"libs":[{"var":"osiDb","module":"osi-db-helper"}]` and a `.close(` call or `test-flows-wiring.js` fails; (5) this plan EXTENDS the existing `prune-sync-outbox` node — it does not add a node — so the edit rewrites that node's `func`.
> **Spec:** [`docs/superpowers/specs/2026-07-08-outbox-retention-size-cap-design.md`](../specs/2026-07-08-outbox-retention-size-cap-design.md) (review round 1 accepted; §D corrected against current-main heartbeat truth). Section refs (§A–§E) point there.

**Goal:** Extend the shipped `prune-sync-outbox` Node-RED node (both profiles) so that, after its existing delivered-row time-prune, it enforces a total-row size cap (`OSI_OUTBOX_MAX_ROWS`, default 50000) by evicting oldest **telemetry-class** rows only (delivered-first), never protected farm-command rows; and if protected rows alone exceed the cap, evicts nothing and raises `node.error` (bumping `error_counts` via the sanctioned catch→`record-error-fn` path) while continuing to accept writes. No schema change, no new node, no boot-node touch.

**Architecture:** The `prune-sync-outbox` node's `func` is rewritten to keep its exact existing delivered-row prune, then append: read `OSI_OUTBOX_MAX_ROWS`; `SELECT COUNT(*)`; if over cap, evict `min(overBy, telemetryCount)` oldest telemetry rows via a `DELETE … WHERE event_uuid IN (SELECT … WHERE aggregate_type IN (<telemetry>) ORDER BY (delivered_at IS NULL), occurred_at LIMIT ?)`; if still over cap because the remainder is protected, call `node.error(...)` (no eviction). Two `Set`s of `aggregate_type` literals (telemetry / protected) live in the node; a CI guard asserts they partition the trigger set's aggregate types. Telemetry = `DEVICE_DATA, CHAMELEON_READING, DENDRO_READING, DENDRO_DAILY, ZONE_ENVIRONMENT, ZONE_RECOMMENDATION`; protected = everything else, default-protected for any new aggregate.

**Tech Stack:** Node-RED function node (`osi-db-helper` facade), `node:test` + `node:sqlite` guard against the real seed schema (the `test-gateway-health-persistence.js` pattern), one-shot Node flows editor. No new dependency, no schema change.

## Global Constraints

- **No schema change:** the cap reads only existing `sync_outbox` columns (`aggregate_type`, `delivered_at`, `occurred_at`, `event_uuid` — all verified present in `seed-blank.sql`). No new column, index, or trigger. `verify-runtime-schema-parity.js` / `verify-seed-replay.js` must stay trivially green (untouched).
- **No boot-node touch, no new node:** rewrite the existing `prune-sync-outbox.func` only. `outbox-retention-tick` inject unchanged.
- **Existing delivered-prune preserved byte-for-byte in behavior:** `OSI_OUTBOX_RETENTION_DAYS` default 30, `DELETE … WHERE delivered_at IS NOT NULL AND delivered_at < ?` — do NOT change (spec Open decision: keep 30).
- **Protected rows are NEVER evicted.** The cap eviction `DELETE` filters `aggregate_type IN (<telemetry set>)`; a bug that lets it touch a protected row is a farm-data-loss incident. The guard test asserts zero protected deletions.
- **Both profiles byte-identical** (`cp` mirror after editing bcm2712).
- CI green at every commit; work on `feat/1A5-outbox-size-cap`, commit per task, PR at end, **do not merge**.

## Non-goals (do not do these)

- No heartbeat/`Gather Edge Health` change (that is item 0.2 — §D dependency; the signal is on-device log + `error_counts` global today).
- No downsampling/aggregation before eviction (oldest-eviction is the v1 mechanism).
- No change to sync delivery logic (which rows get `delivered_at`).
- No lowering of `OSI_OUTBOX_RETENTION_DAYS`.

## File Structure (all changes)

- Create: `scripts/test-outbox-retention.js` (Task 1, guard; committed green in Task 2)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` + byte-identical `bcm2709` mirror (Task 2)
- Modify: `.github/workflows/migrations.yml` (Task 2)
- Modify: `docs/operations/edge-history-retention.md` (Task 3)

---

### Task 1: Write the failing guard test (TDD)

**Files:** Create `scripts/test-outbox-retention.js`.

- [ ] **Step 1.1: Create the test file** with exactly this content:

```js
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
```

> **Test-authoring note (kept honest deliberately):** the cap tests drive `runCapLogic`, a hand-copied mirror of the node's cap SQL, because the shipped node floors `maxRows` at 1000 (so its own cap branch can't be exercised at the small row counts a unit test uses). The mirror's DELETE **must stay byte-identical** to the node's (Step 2.1) — the `node body declares the sets` + partition tests pin the node's SQL statically, and this mirror pins its behavior. If a future change makes the flooring configurable, switch to extracting the DELETE from the node via the `extract(func, 'VAR')` pattern (`test-gateway-health-persistence.js`) to close the drift gap.

- [ ] **Step 1.2: Run it (red)**

```bash
node --test scripts/test-outbox-retention.js 2>&1 | tail -6
```

Expected: the node-shape / declared-sets / byte-identical tests FAIL (the node doesn't yet contain `OSI_OUTBOX_MAX_ROWS` or the sets); the pure-SQL `runCapLogic` tests PASS (they test the SQL contract independently). Record which fail — the flow-shape ones must go green after Task 2. Do NOT commit yet.

---

### Task 2: Rewrite the `prune-sync-outbox` node (both profiles) + CI wiring

**Files:** Modify both `flows.json` copies (via script), `.github/workflows/migrations.yml`; commit `scripts/test-outbox-retention.js`.

- [ ] **Step 2.1: Write the one-shot flows editor** to `/tmp/extend-outbox-prune.js` with exactly this content (it replaces the `prune-sync-outbox` node's `func`, preserving the existing delivered-prune and appending the cap):

```js
#!/usr/bin/env node
// One-shot: rewrite prune-sync-outbox.func in the canonical bcm2712 flows.json to
// add the size cap + per-aggregate drop policy after the existing delivered-prune.
// Item 1.A5. Run once, then cp over the bcm2709 mirror.
'use strict';
const fs = require('fs');
const path = require('path');
const FLOW = path.resolve(process.cwd(),
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

const NEW_FUNC = [
  "// Prune Sync Outbox + Size Cap (item 1.A5).",
  "// 1) delivered-row time-prune (existing behavior, OSI_OUTBOX_RETENTION_DAYS=30).",
  "// 2) total-row size cap (OSI_OUTBOX_MAX_ROWS=50000): evict oldest TELEMETRY rows",
  "//    only, delivered-first; NEVER a protected farm-command row. If protected rows",
  "//    alone exceed the cap, evict nothing and raise node.error (bumps error_counts",
  "//    via the global catch -> Record Error path) while still accepting writes.",
  "// Spec: docs/superpowers/specs/2026-07-08-outbox-retention-size-cap-design.md",
  "// Two explicit sets (spec §B). TELEMETRY rows are evictable oldest-first under",
  "// the cap; PROTECTED rows are NEVER evicted. Any NEW aggregate_type is neither",
  "// telemetry nor listed protected -> it is treated as protected (fail-safe: an",
  "// unclassified aggregate is never silently evicted). PROTECTED is named",
  "// explicitly (not just 'everything else') so the CI partition guard can assert",
  "// the two sets cover exactly the trigger set's aggregate_types.",
  "const TELEMETRY = new Set(['DEVICE_DATA','CHAMELEON_READING','DENDRO_READING','DENDRO_DAILY','ZONE_ENVIRONMENT','ZONE_RECOMMENDATION']);",
  "const PROTECTED = new Set(['IRRIGATION_EVENT','SCHEDULE','ZONE','DEVICE','GATEWAY_LOCATION']);",
  "// SQL IN-list for the eviction DELETE (telemetry only). Derived from TELEMETRY so",
  "// the two never drift.",
  "const TELEMETRY_IN = [...TELEMETRY].map((t) => \"'\" + t + \"'\").join(',');",
  "",
  "const rawDays = String(env.get('OSI_OUTBOX_RETENTION_DAYS') || '30').trim();",
  "const parsedDays = parseInt(rawDays, 10);",
  "const retentionDays = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 30;",
  "const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();",
  "",
  "const rawMax = String(env.get('OSI_OUTBOX_MAX_ROWS') || '50000').trim();",
  "const parsedMax = parseInt(rawMax, 10);",
  "let maxRows = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 50000;",
  "if (maxRows < 1000) { maxRows = 1000; } // floor: a mis-set tiny value must not evict aggressively",
  "",
  "return (async()=>{",
  "  const _db = new osiDb.Database('/data/db/farming.db');",
  "  const q = (sql, params) => new Promise((res,rej) => _db.all(sql, params || [], (e,r) => e?rej(e):res(r||[])));",
  "  const run = (sql, params) => new Promise((res,rej) => _db.run(sql, params || [], e => e?rej(e):res()));",
  "  const close = () => new Promise(res => _db.close(() => res()));",
  "  try {",
  "    // (1) existing delivered-row time-prune — unchanged behavior.",
  "    const delRows = await q('SELECT COUNT(*) AS count FROM sync_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?', [cutoff]);",
  "    const deliveredPruned = Number((delRows[0] || {}).count || 0);",
  "    if (deliveredPruned > 0) {",
  "      await run('DELETE FROM sync_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?', [cutoff]);",
  "    }",
  "",
  "    // (2) size cap.",
  "    const totalRows0 = await q('SELECT COUNT(*) AS n FROM sync_outbox');",
  "    const total = Number((totalRows0[0] || {}).n || 0);",
  "    let evicted = 0;",
  "    let protectedOverCap = false;",
  "    if (total > maxRows) {",
  "      const overBy = total - maxRows;",
  "      const evRows = await q('SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type IN (' + TELEMETRY_IN + ')');",
  "      const evictable = Number((evRows[0] || {}).n || 0);",
  "      const toEvict = Math.min(overBy, evictable);",
  "      if (toEvict > 0) {",
  "        // delivered-first (delivered_at IS NULL -> 1 sorts last), then oldest occurred_at.",
  "        await run('DELETE FROM sync_outbox WHERE event_uuid IN (SELECT event_uuid FROM sync_outbox WHERE aggregate_type IN (' + TELEMETRY_IN + ') ORDER BY (delivered_at IS NULL), occurred_at LIMIT ?)', [toEvict]);",
  "        evicted = toEvict;",
  "      }",
  "      const afterRows = await q('SELECT COUNT(*) AS n FROM sync_outbox');",
  "      const after = Number((afterRows[0] || {}).n || 0);",
  "      if (after > maxRows) {",
  "        // Remainder is all protected. NEVER evict a protected row. Surface + keep accepting.",
  "        protectedOverCap = true;",
  "        node.error('outbox size cap exceeded by protected rows: ' + after + ' protected > cap ' + maxRows, msg);",
  "      }",
  "    }",
  "",
  "    if (deliveredPruned > 0 || evicted > 0) {",
  "      try { await run('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}",
  "    }",
  "    const finalRows = await q('SELECT COUNT(*) AS n FROM sync_outbox');",
  "    const finalTotal = Number((finalRows[0] || {}).n || 0);",
  "    await close();",
  "    node.status({ fill: protectedOverCap ? 'yellow' : 'green', shape: 'dot', text: 'pruned ' + deliveredPruned + ' / evicted ' + evicted + ' / total ' + finalTotal });",
  "    msg.payload = { deliveredPruned, evicted, protectedOverCap, total: finalTotal, cutoff, retentionDays, maxRows };",
  "    return msg;",
  "  } catch (e) {",
  "    try { await close(); } catch (_) {}",
  "    node.warn('Prune Sync Outbox failed: ' + String(e.message || e));",
  "    return null;",
  "  }",
  "})();",
].join('\n');

const flows = JSON.parse(fs.readFileSync(FLOW, 'utf8'));
const node = flows.find((n) => n.id === 'prune-sync-outbox');
if (!node) { console.error('ABORT: prune-sync-outbox not found'); process.exit(1); }
if (node.func.includes('OSI_OUTBOX_MAX_ROWS')) { console.error('ABORT: cap already present'); process.exit(1); }
node.func = NEW_FUNC;
fs.writeFileSync(FLOW, JSON.stringify(flows, null, 2) + '\n');
console.log('OK: prune-sync-outbox func extended with size cap');
```

- [ ] **Step 2.2: Run it, mirror to bcm2709, clean up**

```bash
node /tmp/extend-outbox-prune.js \
  && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  && rm /tmp/extend-outbox-prune.js && echo MIRRORED
```

Expected: `OK: prune-sync-outbox func extended with size cap` then `MIRRORED`.

- [ ] **Step 2.3: Guard test fully green**

```bash
node --test scripts/test-outbox-retention.js 2>&1 | tail -4
```

Expected: `# fail 0` — all shape + partition + cap tests pass.

- [ ] **Step 2.4: Full local gates**

```bash
node scripts/test-flows-wiring.js | tail -1
node scripts/verify-runtime-schema-parity.js
node scripts/verify-sync-flow.js 2>&1 | tail -1
```

Expected: `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`; `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)`; `All parity checks passed.` (No schema/trigger changed, so parity is trivially preserved.)

- [ ] **Step 2.5: Wire the guard into CI.** In `.github/workflows/migrations.yml`, append `scripts/test-outbox-retention.js` to the existing scripts-test `- run: node --test ...` line (the same line other guards use).

- [ ] **Step 2.6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-outbox-retention.js .github/workflows/migrations.yml
git commit -m "feat(flows): sync_outbox size cap with per-aggregate drop policy (#1A5, DD18)"
```

---

### Task 3: Operator documentation + PR

**Files:** Modify `docs/operations/edge-history-retention.md`.

- [ ] **Step 3.1: Append an operator section** to `docs/operations/edge-history-retention.md` documenting:
  - `OSI_OUTBOX_RETENTION_DAYS` (default 30) — delivered-row time-prune (existing).
  - `OSI_OUTBOX_MAX_ROWS` (default 50000, floored 1000) — total-row size cap; evicts oldest telemetry rows (`DEVICE_DATA, CHAMELEON_READING, DENDRO_READING, DENDRO_DAILY, ZONE_ENVIRONMENT, ZONE_RECOMMENDATION`) delivered-first; NEVER evicts protected aggregates (`IRRIGATION_EVENT, SCHEDULE, ZONE, DEVICE, GATEWAY_LOCATION`).
  - The **protected-over-cap signal**: if protected rows alone exceed the cap, the node evicts nothing, logs `outbox size cap exceeded by protected rows: …` (visible in the Node-RED log and bumping `error_counts`), and keeps accepting writes. Remote heartbeat visibility of this depends on item 0.2 (`errors_total`); until then it is log-only. What an operator should do: investigate why the gateway is weeks-offline / not delivering; the backlog is bounded on disk but signals a delivery problem.

- [ ] **Step 3.2: Commit**

```bash
git add docs/operations/edge-history-retention.md
git commit -m "docs(ops): document sync_outbox retention + size-cap knobs and protected-over-cap signal (#1A5)"
```

- [ ] **Step 3.3: Push branch and open the PR (do not merge)**

```bash
git push -u origin feat/1A5-outbox-size-cap
gh pr create --title "feat(flows): sync_outbox retention size cap with per-aggregate drop policy (item 1.A5, DD18)" --body "<body per below>"
```

PR body: (1) scope — item 1.A5 / DD18 per the spec (link it); extends the existing `prune-sync-outbox` node, no schema/boot-node change; (2) the drop policy (telemetry evictable delivered-first, protected never) and the protected-over-cap fail-safe in two sentences; (3) the §D correction — heartbeat does not carry `error_counts` today; signal is log + global context, remote visibility gated on item 0.2; (4) real outputs from Task 2 (guard `# fail 0`, `verify-sync-flow` `All parity checks passed.`, `test-flows-wiring` PASS); (5) the retention-default decision (kept 30, size cap is the real bound) and the FABLE-DECISION flag on 30-vs-7. Reference DD18.

## Follow-ups (not plan tasks)

- Heartbeat visibility of the protected-over-cap signal lands with item 0.2 (`Gather Edge Health` gains `errors_total`) — no change needed here when it does.
