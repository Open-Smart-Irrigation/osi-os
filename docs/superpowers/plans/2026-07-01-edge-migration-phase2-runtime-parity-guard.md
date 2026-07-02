# Edge Migration Phase 2 — Runtime Schema Parity Guard + CHECK Repair

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes (learned the hard way):** (1) work inside your feature worktree, not the root checkout; (2) `scripts/verify-runtime-schema-parity.js` must start with the `#!/usr/bin/env node` shebang as its **first line** — no comment before it, or Node rejects it.

**Goal:** Repair the regressed `devices_new` CHECK in the shipped Node-RED flow, and add a CI guard that fails whenever the shipped flow **downgrades** the canonical seed schema — closing the drift bug class that just recurred.

**Architecture:** A standalone verifier (`scripts/verify-runtime-schema-parity.js`) derives the canonical device-type CHECK set and trigger set from `database/seed-blank.sql` (via the `sqlite3` CLI), then compares them to the shipped `flows.json`: the `devices_new` CHECK from the `sync-init-fn` rebuild, and the trigger set across the **whole flow** (triggers are created by several nodes, not just `sync-init-fn`). It fails only on a **downgrade** (CHECK/trigger). This is Option A of a multi-role design debate; rewiring `sync-init-fn` → the Phase-1 runner is deferred to a separate boot-path project (Option B) behind trigger conditions (Task 4).

**Tech Stack:** Node.js (`node:child_process`), the `sqlite3` CLI 3.53 (matches `lib/osi-migrate`). No new dependencies.

## Global Constraints

- No new runtime npm dependencies; Node built-ins + the `sqlite3` CLI only.
- The parity guard reads the **shipped artifact** — `conf/*/files/usr/share/flows.json` — because the regression occurred in the shipped flow.
- Canonical device-type set (must be in the `devices` CHECK): `KIWI_SENSOR, STREGA_VALVE, DRAGINO_LSN50, TEKTELIC_CLOVER, SENSECAP_S2120, AQUASCOPE_LORAIN`. `GATEWAY` is server-only — do NOT add it to the edge CHECK.
- Boot-DDL freeze (Task 4): no new inline schema work in `sync-init-fn` beyond the narrow CHECK repair.
- Affected profiles: the two full images (`bcm2712`, `bcm2709`). The minimal `bcm2708` image has no `sync-init-fn` and is out of scope.
- **Known separate issue (out of scope — Option B):** `sync-init-fn` has 93 inline `ADD COLUMN`s — 81 already exist in the seed (redundant) and 12 add columns the seed lacks. This causes `verify-sync-flow.js` to be pre-existing RED (`duplicate column name: data_invalid`, then `comp_pending`, `event_uuid`, …). Do NOT try to fix that here; the parity guard deliberately does NOT fail on column/table drift (only on CHECK/trigger downgrade).

---

### Task 1: Write the parity verifier (fails on the current regression)

**Files:**
- Create: `scripts/verify-runtime-schema-parity.js`

**Interfaces:**
- Produces: a CLI that exits non-zero **only** when the shipped flow DOWNGRADES the seed — (a) the `sync-init-fn` `devices_new` CHECK device-type set != the seed's `devices` CHECK set, or (b) the whole-flow trigger set != the seed's trigger set. It does NOT check tables or added columns (that flow-ahead drift is Option-B territory; see Global Constraints).

- [ ] **Step 1: Write the verifier** (first line MUST be the shebang)

```js
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
  const m = /CHECK\s*\(\s*type_id\s+IN\s*\(([\s\S]*?)\)/i.exec(sql || '');
  return new Set(((m && m[1].match(/'[^']*'/g)) || []).map((s) => s.slice(1, -1)));
}
function triggerNames(text) {
  return new Set([...text.matchAll(/CREATE TRIGGER (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]));
}

// Canonical schema from the seed: the devices CHECK type-set and the full trigger set.
const canonDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parity-')), 'canon.db');
execFileSync('sqlite3', ['-bail', canonDb], { input: fs.readFileSync(SEED, 'utf8'), encoding: 'utf8' });
const canonDevices = checkTypes((q(canonDb, "SELECT sql FROM sqlite_master WHERE name='devices'")[0] || {}).sql);
const canonTriggers = new Set(q(canonDb, "SELECT name FROM sqlite_master WHERE type='trigger'").map((r) => r.name));

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const diff = (a, b) => [...a].filter((x) => !b.has(x));

const problems = [];
for (const flowPath of FLOWS) {
  const rel = path.relative(repo, flowPath);
  const raw = fs.readFileSync(flowPath, 'utf8');
  const node = JSON.parse(raw).find((n) => n.id === 'sync-init-fn');
  if (!node) throw new Error(`${rel}: sync-init-fn node not found`);

  // (a) devices_new CHECK — the regression site (specific to sync-init-fn's rebuild).
  const dm = /devices_new\s*\(id[\s\S]*?CHECK\s*\(\s*type_id\s+IN\s*\(([\s\S]*?)\)/i.exec(node.func || '');
  const devTypes = new Set(((dm && dm[1].match(/'[^']*'/g)) || []).map((s) => s.slice(1, -1)));
  if (!setEq(devTypes, canonDevices)) {
    problems.push(`${rel}: sync-init-fn devices_new CHECK != canonical seed. missing=[${diff(canonDevices, devTypes)}] extra=[${diff(devTypes, canonDevices)}]`);
  }

  // (b) triggers — created across MULTIPLE flow nodes, so compare the WHOLE flow text.
  const flowTriggers = triggerNames(raw);
  if (!setEq(flowTriggers, canonTriggers)) {
    problems.push(`${rel}: flow trigger set != canonical seed. missing=[${diff(canonTriggers, flowTriggers)}] extra=[${diff(flowTriggers, canonTriggers)}]`);
  }
}

if (problems.length) {
  console.error('verify-runtime-schema-parity: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`verify-runtime-schema-parity: OK (${FLOWS.length} flows: devices CHECK + trigger parity)`);
process.exit(0);
```

- [ ] **Step 2: Run it — it must FAIL on the current regression**

Run: `node scripts/verify-runtime-schema-parity.js`
Expected: FAIL with **exactly** the CHECK problem for both profiles:
```
  - conf/.../bcm2712/.../flows.json: sync-init-fn devices_new CHECK != canonical seed. missing=[AQUASCOPE_LORAIN] extra=[]
  - conf/.../bcm2709/.../flows.json: sync-init-fn devices_new CHECK != canonical seed. missing=[AQUASCOPE_LORAIN] extra=[]
```
There must be NO `trigger set != canonical` line (whole-flow trigger sets match the seed's 31). If a trigger problem appears, STOP and report — the whole-flow trigger extraction is off.

- [ ] **Step 3: Commit the verifier (red)**

```bash
git add scripts/verify-runtime-schema-parity.js
git commit -m "test(schema): add runtime<->seed CHECK/trigger parity guard (red: devices CHECK regressed)"
```

---

### Task 2: Repair the `devices_new` CHECK in both shipped flows

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (`sync-init-fn` func)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (`sync-init-fn` func)

**Interfaces:**
- Consumes: the verifier from Task 1.
- Produces: both flows' `devices_new` CREATE uses the canonical 6-type CHECK → verifier green. No other flow logic changes.

- [ ] **Step 1: Find the exact stale CHECK string**

Run: `grep -o "devices_new (id[^;]*type_id TEXT NOT NULL CHECK(type_id IN ([^)]*))" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json | head -1`
Expected: `…CHECK(type_id IN ('KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120'))` (5 types).

- [ ] **Step 2: Replace the 5-type list with the canonical 6-type list in BOTH profiles**

In each flows.json, replace the exact substring
`CHECK(type_id IN ('KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120'))`
(the one inside the `devices_new` create) with
`CHECK(type_id IN ('KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN'))`.
Do not alter the non-`_new` `devices` CHECK or any other node. Keep each `flows.json` valid JSON.

- [ ] **Step 3: Verify — parity green, JSON valid, no NEW regressions**

Run: `node scripts/verify-runtime-schema-parity.js`
Expected: `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)` (exit 0).

Run: `node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'))" && echo JSON-OK-2712`
Run: `node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'))" && echo JSON-OK-2709`
Expected: both print `JSON-OK-…`.

Run: `node scripts/verify-db-schema-consistency.js`
Expected: passes (it checks seeded `farming.db` column contracts, independent of the flow's inline DDL).

Run: `node scripts/verify-sync-flow.js`
Expected: **pre-existing RED, unchanged by your edit.** It bails with `Parse error … duplicate column name: data_invalid` (a redundant inline `ADD COLUMN`, one of ~81 — Option-B territory, see Global Constraints). Your CHECK edit is in `devices_new` (a different table), so confirm the FIRST parse error is still `data_invalid` — i.e. you introduced no NEW failure. Do NOT try to make this verifier green here.

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
- Produces: CI fails on any future runtime→seed schema **downgrade**.

- [ ] **Step 1: Add the verifier step to the existing migrations workflow**

Add, after the existing `verify-seed-replay.js` step in `.github/workflows/migrations.yml`:

```yaml
      - run: node scripts/verify-runtime-schema-parity.js
```

- [ ] **Step 2: Confirm the CI command set passes locally**

Run: `node --test lib/osi-migrate/__tests__/*.test.js && node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js`
Expected: all pass (45 tests; three verifiers print OK). (Note: `verify-sync-flow.js` is NOT added to CI here — it is pre-existing red, an Option-B concern.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/migrations.yml
git commit -m "ci(schema): gate shipped flow devices CHECK + triggers against canonical seed"
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
on every boot (incl. ~93 ADD COLUMNs, 81 of them redundant with the seed — the cause
of verify-sync-flow's pre-existing `duplicate column` failures). This node is FROZEN:
do not add new schema behavior there. New schema changes go through the migration
runner (`lib/osi-migrate`). `scripts/verify-runtime-schema-parity.js` (CI-gated) fails
if the shipped flow DOWNGRADES `database/seed-blank.sql` (devices CHECK / triggers).
Replacing the inline boot DDL with the runner ("Option B") is a separate boot-path
project — see the ADR trigger conditions.
```

- [ ] **Step 2: Record the Option-B trigger conditions in the ADR**

Append to `docs/adr/2026-06-30-schema-and-contract-ownership.md`:

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
Cleaning up the ~81 redundant inline ADD COLUMNs (and greening verify-sync-flow) is
part of this cutover, not a standalone task. Until then: freeze + guard the boot node.
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
- CI parity guard on CHECK + trigger **downgrades** vs the canonical seed → Tasks 1, 3.
- Boot-DDL freeze + explicit Option-B trigger conditions → Task 4.
- **Deferred (correctly, to Option B):** rewiring `sync-init-fn` to the runner; the ~81 redundant `ADD COLUMN` cleanup; greening `verify-sync-flow`; the deploy/boot state machine.

**Placeholder scan:** none — the verifier is complete runnable code (shebang first); the CHECK repair gives exact before/after strings; the docs give exact text.

**Consistency:** the canonical 6-type set is identical in the Global Constraints, the seed-derived canonical extraction, and the Task-2 replacement string. The verifier reads the same shipped `flows.json` paths the fix edits. Triggers are compared whole-flow (they are created by several nodes), which is why Task-1 Step-2 expects no trigger problem.

**TDD shape:** Task 1 commits the verifier RED (fails on the CHECK regression); Task 2 makes it GREEN — the verifier *is* the failing test for the fix.
