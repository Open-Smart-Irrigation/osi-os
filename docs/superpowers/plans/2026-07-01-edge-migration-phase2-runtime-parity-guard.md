# Edge Migration Phase 2 — Runtime Schema Parity Guard + CHECK Repair

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the regressed `devices_new` CHECK in the shipped Node-RED flow, and add a CI guard that fails whenever the shipped flow's schema diverges from the canonical seed/baseline — closing the drift bug class that just recurred.

**Architecture:** A standalone verifier (`scripts/verify-runtime-schema-parity.js`) builds the canonical schema from `database/seed-blank.sql` (via the `sqlite3` CLI) and extracts the schema the runtime `sync-init-fn` node produces (device-type CHECK, triggers, tables, added columns) from the *shipped* `flows.json` in each profile, then asserts parity. This is the outcome of a multi-role design debate: it is Option A ("ship the guard now"), with the consumer-rewiring of `sync-init-fn` → the Phase-1 runner explicitly deferred to a separate boot-path project (Option B) behind trigger conditions (see Task 4).

**Tech Stack:** Node.js (`node:test`, `node:child_process`), the `sqlite3` CLI 3.53 (matches `lib/osi-migrate` + `scripts/repair-pi-schema.js`). No new dependencies.

## Global Constraints

- No new runtime npm dependencies; Node built-ins + the `sqlite3` CLI only.
- The parity guard reads the **shipped artifact** — `conf/*/files/usr/share/flows.json` — because the regression occurred in the shipped flow, not in a source-of-truth file.
- Canonical device-type set (must be in the `devices` CHECK): `KIWI_SENSOR, STREGA_VALVE, DRAGINO_LSN50, TEKTELIC_CLOVER, SENSECAP_S2120, AQUASCOPE_LORAIN`. `GATEWAY` is server-only — do NOT add it to the edge CHECK.
- Boot-DDL freeze (Task 4): no new inline schema work in `sync-init-fn` beyond the narrow CHECK repair. New schema behavior belongs in the migration runner (Option B), which is out of scope here.
- Run tests with the glob: `node --test lib/osi-migrate/__tests__/*.test.js`. Run the new verifier with `node scripts/verify-runtime-schema-parity.js`.
- Affected profiles: the two full images (`bcm2712`, `bcm2709`). The minimal `bcm2708` image has no `sync-init-fn` and is out of scope.

---

### Task 1: Write the parity verifier (fails on the current regression)

**Files:**
- Create: `scripts/verify-runtime-schema-parity.js`

**Interfaces:**
- Produces: a CLI that exits `0` when every shipped `flows.json` `sync-init-fn` schema matches the canonical seed, and non-zero (with a diff message) otherwise. Checks: (a) device-type CHECK set equals canonical; (b) trigger set equals canonical; (c) every `CREATE TABLE` in the flow is a canonical table; (d) every `ALTER TABLE … ADD COLUMN` target column exists in the canonical table.

- [ ] **Step 1: Write the verifier**

```js
// scripts/verify-runtime-schema-parity.js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const SEED = path.join(repo, 'database/seed-blank.sql');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(repo, p));

function q(db, sql) {
  const out = execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}

function checkTypes(sql) {
  const m = /type_id[^)]*CHECK\s*\(\s*type_id\s+IN\s*\(([^)]*)\)/i.exec(sql || '');
  return new Set(((m && m[1].match(/'[^']*'/g)) || []).map((s) => s.slice(1, -1)));
}

// Canonical schema, built from the seed via sqlite3.
function canonical() {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parity-')), 'canon.db');
  execFileSync('sqlite3', ['-bail', db], { input: fs.readFileSync(SEED, 'utf8'), encoding: 'utf8' });
  const tables = new Set(q(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name));
  const triggers = new Set(q(db, "SELECT name FROM sqlite_master WHERE type='trigger'").map((r) => r.name));
  const devicesSql = (q(db, "SELECT sql FROM sqlite_master WHERE name='devices'")[0] || {}).sql;
  const columns = {};
  for (const t of tables) columns[t] = new Set(q(db, `PRAGMA table_info(${t})`).map((r) => r.name));
  return { tables, triggers, deviceTypes: checkTypes(devicesSql), columns };
}

// Runtime schema, extracted from a shipped flow's sync-init-fn func text.
function runtime(flowPath) {
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  const node = flow.find((n) => n.id === 'sync-init-fn');
  if (!node) throw new Error(`${path.relative(repo, flowPath)}: sync-init-fn node not found`);
  const f = node.func || '';
  const grabAll = (re, g) => { const out = []; let m; while ((m = re.exec(f))) out.push(m[g]); return out; };
  const devMatch = /devices_new\s*\(id[^;]*?CHECK\s*\(\s*type_id\s+IN\s*\(([^)]*)\)/i.exec(f);
  return {
    deviceTypes: new Set(((devMatch && devMatch[1].match(/'[^']*'/g)) || []).map((s) => s.slice(1, -1))),
    triggers: new Set(grabAll(/CREATE TRIGGER (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi, 1)),
    tables: new Set(grabAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi, 1).filter((n) => n !== 'devices_new')),
    addColumns: grabAll(/ALTER TABLE ([a-z_][a-z0-9_]*) ADD COLUMN ([a-z_][a-z0-9_]*)/gi, 0)
      .map((s) => { const m = /ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(s); return [m[1], m[2]]; }),
  };
}

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const diff = (a, b) => [...a].filter((x) => !b.has(x));

const canon = canonical();
const problems = [];
for (const flowPath of FLOWS) {
  const rel = path.relative(repo, flowPath);
  const rt = runtime(flowPath);
  if (!setEq(rt.deviceTypes, canon.deviceTypes)) {
    problems.push(`${rel}: devices_new CHECK != canonical. missing=[${diff(canon.deviceTypes, rt.deviceTypes)}] extra=[${diff(rt.deviceTypes, canon.deviceTypes)}]`);
  }
  if (!setEq(rt.triggers, canon.triggers)) {
    problems.push(`${rel}: trigger set != canonical. missing=[${diff(canon.triggers, rt.triggers)}] extra=[${diff(rt.triggers, canon.triggers)}]`);
  }
  for (const t of rt.tables) if (!canon.tables.has(t)) problems.push(`${rel}: flow creates non-canonical table '${t}'`);
  for (const [t, c] of rt.addColumns) {
    if (canon.columns[t] && !canon.columns[t].has(c)) problems.push(`${rel}: flow ADDs column ${t}.${c} absent from the canonical seed`);
  }
}

if (problems.length) {
  console.error('verify-runtime-schema-parity: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`verify-runtime-schema-parity: OK (${FLOWS.length} flows match canonical seed)`);
process.exit(0);
```

- [ ] **Step 2: Run it — it must FAIL on the current regression**

Run: `node scripts/verify-runtime-schema-parity.js`
Expected: FAIL, listing `devices_new CHECK != canonical. missing=['AQUASCOPE_LORAIN']` for both profiles. (This proves the guard catches the exact regression.)

- [ ] **Step 3: Commit the verifier (red)**

```bash
git add scripts/verify-runtime-schema-parity.js
git commit -m "test(schema): add runtime<->seed parity guard (currently red: devices CHECK regressed)"
```

---

### Task 2: Repair the `devices_new` CHECK in both shipped flows

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (`sync-init-fn` func)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (`sync-init-fn` func)

**Interfaces:**
- Consumes: the verifier from Task 1.
- Produces: both flows' `devices_new` CREATE uses the canonical 6-type CHECK, making the verifier pass. No other flow logic changes (the guard + fail-safe from the original hotfix stay as-is).

- [ ] **Step 1: Find the exact stale CHECK string**

Run: `grep -o "devices_new (id[^;]*type_id TEXT NOT NULL CHECK(type_id IN ([^)]*))" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json | head -1`
Expected: shows `…CHECK(type_id IN ('KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120'))` (5 types).

- [ ] **Step 2: Replace the 5-type list with the canonical 6-type list in BOTH profiles**

For each of the two flows.json, replace the exact substring
`CHECK(type_id IN ('KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120'))`
(within the `devices_new` create) with
`CHECK(type_id IN ('KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN'))`.
Edit only that occurrence inside the `sync-init-fn` `devices_new` create; do not alter the `devices` (non-`_new`) CHECK or any other node. Keep each `flows.json` valid JSON.

- [ ] **Step 3: Verify parity now passes + JSON valid + no other regressions**

Run: `node scripts/verify-runtime-schema-parity.js`
Expected: `verify-runtime-schema-parity: OK (2 flows match canonical seed)`.

Run: `node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'))" && echo JSON-OK-2712`
Run: `node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'))" && echo JSON-OK-2709`
Expected: both print `JSON-OK-…`.

Run: `node scripts/verify-sync-flow.js`
Expected: passes (the FK-fence guard + chained checks still hold — the CHECK change does not touch the fence).

Run: `node scripts/verify-db-schema-consistency.js`
Expected: passes.

- [ ] **Step 4: Commit the fix (green)**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "fix(sync): restore AQUASCOPE_LORAIN in devices_new CHECK (both full images)"
```

---

### Task 3: Wire the parity guard into CI

**Files:**
- Modify: `.github/workflows/migrations.yml`

**Interfaces:**
- Consumes: `scripts/verify-runtime-schema-parity.js`.
- Produces: CI fails on any future runtime↔seed schema divergence.

- [ ] **Step 1: Add the verifier step to the existing migrations workflow**

Add this run step after the existing `verify-seed-replay.js` step in `.github/workflows/migrations.yml`:

```yaml
      - run: node scripts/verify-runtime-schema-parity.js
```

- [ ] **Step 2: Confirm the full CI command set passes locally**

Run: `node --test lib/osi-migrate/__tests__/*.test.js && node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js`
Expected: all pass (45 tests; three verifiers print OK).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/migrations.yml
git commit -m "ci(schema): gate shipped flow schema against canonical seed"
```

---

### Task 4: Document the boot-DDL freeze + Option-B trigger conditions

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/adr/2026-06-30-schema-and-contract-ownership.md`

**Interfaces:**
- Produces: an explicit, discoverable rule that the boot node is frozen and that replacing it (Option B) is gated on named conditions — so "parity guard shipped" is not misread as "schema risk solved."

- [ ] **Step 1: Add a boot-DDL freeze note to AGENTS.md**

Under the edge/schema section of `AGENTS.md`, add:

```markdown
### Boot-DDL freeze (edge schema)

`sync-init-fn` (Node-RED "Sync Init Schema + Triggers") performs schema DDL inline
on every boot. This is FROZEN: do not add new schema behavior there. New schema
changes go through the migration runner (`lib/osi-migrate`). `scripts/verify-runtime-schema-parity.js`
(CI-gated) fails if the shipped flow's schema diverges from `database/seed-blank.sql`.
Replacing the inline boot DDL with the runner ("Option B") is a separate boot-path
project — see the ADR trigger conditions.
```

- [ ] **Step 2: Record the Option-B trigger conditions in the ADR**

Append to `docs/adr/2026-06-30-schema-and-contract-ownership.md` a short section:

```markdown
## Boot-path migration cutover (Option B) — trigger conditions

The edge migration runner (Phase 1) exists but does not yet run on-device; the
Node-RED boot node still owns inline schema DDL (frozen — see AGENTS.md). Replacing
it with the runner is deferred until a real runtime migration need appears, AND the
deploy/boot machinery is designed first (preflight fingerprint, backup provenance,
fail-closed behavior, rollback, observability, post-boot verification) and rehearsed
on a copied production DB + rebuildable demo gateways. Promote Option B only when a
non-trivial production-bound schema change appears: a table rebuild, trigger
replacement, destructive cleanup, data backfill, or an ordering-sensitive migration.
Until then: freeze + guard the boot node; do not treat it as a normal place to add
schema behavior.
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/adr/2026-06-30-schema-and-contract-ownership.md
git commit -m "docs(schema): boot-DDL freeze + Option-B cutover trigger conditions"
```

---

## Self-Review

**Scope coverage (Option A, per the design debate):**
- Fix the regressed `devices_new` CHECK on the shipped artifact → Task 2.
- CI parity guard comparing canonical seed/baseline to the shipped runtime flow schema → Tasks 1, 3.
- Boot-DDL freeze + explicit Option-B trigger conditions (so "A shipped" ≠ "risk solved") → Task 4.
- **Deferred (correctly):** Option B — rewiring `sync-init-fn` to call the runner, the deploy/boot state machine, Node-RED packaging of `lib/osi-migrate`. Gated behind Task 4's trigger conditions.

**Placeholder scan:** none — the verifier is complete runnable code; the CHECK repair gives the exact before/after strings; the docs give exact text.

**Consistency:** the canonical 6-type set is identical in the Global Constraints, the verifier's canonical extraction (from the seed), and the Task-2 replacement string. The verifier reads the same shipped `flows.json` paths the fix edits.

**Note on TDD shape:** Task 1 commits the verifier RED (it fails on the current regression), Task 2 makes it GREEN — the verifier *is* the failing test for the fix.
