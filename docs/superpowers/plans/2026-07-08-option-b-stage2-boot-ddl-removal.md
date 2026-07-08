# Option B Stage 2 — Boot-Node DDL Removal (issue #88) Implementation Plan

> ## ⛔ GATED — DO NOT EXECUTE until the gates below are green
> This plan removes the boot-node schema self-heal — the refactor program's named
> **riskiest one-way door** (a wrong-schema gateway becomes field-unrecoverable).
> It is the design/execution plan of record but must NOT run until GATES GA–GD
> (spec §Gates) are satisfied with real evidence. The gates depend on Stage 1
> (1.B1) proven fleet-wide **including Uganda** (item 2.1) and the 5.2 chaos rig
> (Batch D). This is deliberately the LAST Option-B change.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes:** (1) feature worktree/branch (`feat/88-stage2-boot-ddl-removal`), not root `main`; (2) after editing the bcm2712 `flows.json`, `cp` it byte-for-byte over the bcm2709 mirror (`verify-profile-parity.js`); (3) `flows.json` is `JSON.stringify(flows, null, 2) + '\n'` — edit via a one-shot Node script, never by hand; (4) this edits the FROZEN `sync-init-fn` node — the **sanctioned unfreezing moment** — so the FULL boot-node merge gate applies (four verifiers + rehearsal, spec §merge-gate); (5) this plan is **two sub-steps across two releases**: 2a (this plan) strips the sweep/DDL/request-path DDL and KEEPS the `devices` rebuild; 2b (a follow-up plan, one release later) strips the `devices` rebuild.
> **Spec:** [`docs/superpowers/specs/2026-07-08-option-b-stage2-boot-ddl-removal-design.md`](../specs/2026-07-08-option-b-stage2-boot-ddl-removal-design.md) (review round 1 accepted; trigger count corrected to 31). Section refs point there.

**Goal (sub-step 2a):** Remove from the `sync-init-fn` boot node (both profiles): the ~93 `ADD COLUMN` sweep, the inline table/index/trigger CREATE DDL, and the `writable_schema` block; leaving it running read-only `verifyHead` + `schema_sig` reporting **plus the kept fail-closed `devices`-CHECK rebuild**. Remove the two request-path `CREATE TABLE IF NOT EXISTS valve_actuation_expectations` occurrences (`zone-env-fn`, `get-actuations-query`). All boot-node merge-gate verifiers green; `verify-no-stray-ddl.js` counts drop and its baseline snapshot regenerated.

**Architecture:** A one-shot Node editor rewrites `sync-init-fn.func` to the read-only-plus-rebuild form and deletes the request-path `CREATE TABLE` from the two named nodes. Because the node body is large and intricate, the editor operates on the parsed node and writes a NEW func assembled from (a) a small read-only `verifyHead`/`schema_sig` preamble and (b) the VERBATIM extracted `devices`-rebuild block (copied out of the current func, not rewritten — so the fail-closed fence stays byte-exact and `verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild.test.js` still pass). A TDD guard asserts the DDL genera are gone and the rebuild + read-only reporting remain.

**Tech Stack:** Node-RED function node, `node:test`, one-shot Node flows editor, the existing boot-node verifier suite. No schema change, no runner change, no new dependency.

## Global Constraints

- **No schema change, no runner change, no new migration.** Stage 2 REMOVES boot DDL; the schema is owned by seed + ordered migrations delivered via Stage 1.
- **Keep the `devices`-CHECK rebuild byte-exact (2a).** Extract it verbatim from the current `sync-init-fn` func; do NOT rewrite it. `verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild.test.js` must stay green (they run the actual shipped function text).
- **The 31st trigger (`sync_dendro_to_readings`) is NOT touched** — it is boot-created by `dendro-compute-fn` (out of scope). Rehearsal asserts all 31 triggers present (30 runner-delivered + this 1 boot-created).
- **Both profiles byte-identical** (`cp` mirror).
- **Full boot-node merge gate** before commit: `verify-runtime-schema-parity.js`, `verify-profile-parity.js`, `verify-devices-rebuild-fence.js`, `rehearse-devices-rebuild.test.js`, `verify-sync-flow.js`, `verify-no-stray-ddl.js` — all green.
- Work on `feat/88-stage2-boot-ddl-removal`, commit per task, PR at end, **do not merge until gates + rehearsal evidence exist**.

## Gates (must be green before executing — spec §Gates, recorded here before running)

- [ ] **GA** — Two clean fleet deliveries via 1.B1 including Uganda. Evidence: __________
- [ ] **GB** — Fleet-wide `schema_sig` convergence for a sustained window. Evidence: __________
- [ ] **GC** — Power-loss-mid-migration rehearsed on the 5.2 chaos rig (Batch D). Evidence: __________
- [ ] **GD** — item 2.1 (Uganda catch-up) complete. Evidence: __________

**If any gate is unchecked, STOP — this plan is design-only.**

## Non-goals (do not do these)

- No `devices`-rebuild removal (that is sub-step 2b, a separate follow-up plan one release later).
- No touch to `dendro-compute-fn` or the 31st trigger.
- No runner/migration/schema change.
- No live gateway outside the gated canary rollout (which is an operator step, not a plan task).

## File Structure (all changes)

- Create: `scripts/test-boot-ddl-removed.js` (Task 1 guard; committed green in Task 2)
- Modify: both `flows.json` profiles (via script, Task 2)
- Modify: `scripts/verify-runtime-schema-parity.js` (trigger-parity check no longer sourced from flows text, Task 2 Step 2.4)
- Modify: `scripts/verify-no-stray-ddl-baseline.json` (regenerated snapshot, Task 2)
- Modify: `.github/workflows/migrations.yml` (wire the guard, Task 2)
- Modify: `.claude/skills/osi-schema-change-control/SKILL.md` (record the unfreezing + updated boot-node state, Task 3)

---

### Task 0: Gate check (no commit)

- [ ] **Step 0.1:** Confirm GA–GD above are all checked with real evidence. If not, STOP. Record the evidence inline.
- [ ] **Step 0.2:** Baseline green on the branch base:

```bash
cd "$(git rev-parse --show-toplevel)"
node scripts/verify-sync-flow.js 2>&1 | tail -1        # All parity checks passed.
node scripts/verify-devices-rebuild-fence.js           # OK (2 flows)
node --test scripts/rehearse-devices-rebuild.test.js 2>&1 | tail -2   # 4/4 pass
node scripts/verify-no-stray-ddl.js                    # passes at current counts
```

Record the current `sync-init-fn` DDL counts (the surgery must reduce them):

```bash
node -e '
const fs=require("fs");
const flows=JSON.parse(fs.readFileSync("conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json","utf8"));
const n=flows.find(x=>x.id==="sync-init-fn"); const f=n.func;
const c=(re)=>(f.match(re)||[]).length;
console.log("ADD COLUMN:",c(/ADD COLUMN/g),"writable_schema:",c(/writable_schema/g),
  "DROP TRIGGER:",c(/DROP TRIGGER/g),"CREATE TRIGGER:",c(/CREATE TRIGGER/g),
  "devices_new:",c(/devices_new/g),"CREATE TABLE:",c(/CREATE TABLE/g));
'
```

Expected (spec §Problem): `ADD COLUMN: 93 writable_schema: 2 DROP TRIGGER: 30 CREATE TRIGGER: 30 devices_new: 7 CREATE TABLE: <n>`. Record the numbers — the guard test pins the AFTER state against these.

---

### Task 1: Write the failing guard test (TDD)

**Files:** Create `scripts/test-boot-ddl-removed.js`.

- [ ] **Step 1.1: Create the guard** with exactly this content:

```js
#!/usr/bin/env node
// Guard for item 4.3 sub-step 2a — boot-node DDL removed, devices rebuild kept,
// read-only reporting present, request-path DDL gone. Spec:
//   docs/superpowers/specs/2026-07-08-option-b-stage2-boot-ddl-removal-design.md
// Run: node --test scripts/test-boot-ddl-removed.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const FLOW_PATHS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((rel) => path.join(REPO, rel));

function nodeById(fp, id) {
  return JSON.parse(fs.readFileSync(fp, 'utf8')).find((n) => n.id === id);
}
const count = (s, re) => (s.match(re) || []).length;
// Compile-check a function node's body exactly as Node-RED wraps it (async
// function body). Throws SyntaxError if the edit produced invalid JS — this is
// the net that closes the "mis-stripped node passes all gates but breaks at
// runtime" gap for get-actuations-query, which no other verifier compiles.
function assertNodeCompiles(fp, id) {
  const n = nodeById(fp, id);
  assert.ok(n, `${id} missing in ${fp}`);
  // Node-RED runs the func as the body of `async function(msg){ ... }`.
  new vm.Script(`(async function(msg){ ${n.func}\n})`, { filename: `${id}.func.js` });
}

for (const fp of FLOW_PATHS) {
  const rel = path.relative(REPO, fp);

  test(`${rel}: sync-init-fn has NO ADD COLUMN sweep and NO writable_schema (2a)`, () => {
    const f = nodeById(fp, 'sync-init-fn').func;
    assert.equal(count(f, /ADD COLUMN/g), 0, 'ADD COLUMN sweep must be removed');
    assert.equal(count(f, /writable_schema/g), 0, 'writable_schema block must be removed');
  });

  test(`${rel}: sync-init-fn has NO inline trigger convergence DDL (2a)`, () => {
    const f = nodeById(fp, 'sync-init-fn').func;
    // The 30 DROP/CREATE TRIGGER convergence is gone; the runner owns trigger DDL now.
    assert.equal(count(f, /DROP TRIGGER/g), 0, 'boot trigger DROP convergence must be removed');
    assert.equal(count(f, /CREATE TRIGGER/g), 0, 'boot trigger CREATE convergence must be removed');
  });

  test(`${rel}: sync-init-fn KEEPS the fail-closed devices rebuild (2a keeps it)`, () => {
    const f = nodeById(fp, 'sync-init-fn').func;
    assert.ok(f.includes('devices_new'), 'devices rebuild block must remain in 2a');
    assert.ok(f.includes('REQUIRED_TYPES') || /AQUASCOPE_LORAIN/.test(f), 'rebuild guard set must remain');
    assert.ok(!/INSERT OR IGNORE INTO devices_new/.test(f), 'rebuild must stay fail-closed (plain INSERT)');
    assert.ok(/foreign_keys\s*=\s*OFF/i.test(f) && /foreign_keys\s*=\s*ON/i.test(f), 'FK fence must remain');
  });

  test(`${rel}: sync-init-fn is read-only aside from the kept rebuild (no exec/run DDL)`, () => {
    const f = nodeById(fp, 'sync-init-fn').func;
    // Positive: it reports status read-only.
    assert.match(f, /node\.status\(/);
    // Negative: outside the kept devices rebuild, no schema-mutating DDL remains.
    // (The rebuild legitimately contains CREATE TABLE devices_new / DROP TABLE
    //  devices_old; those are the ONLY DDL allowed, all within the rebuild block.)
    assert.equal(count(f, /ALTER TABLE/g), 0, 'no ALTER TABLE outside removed sweep');
    // Every CREATE TABLE present must be part of the devices rebuild (devices_new).
    for (const m of f.matchAll(/CREATE TABLE[^\n;]*/g)) {
      assert.ok(/devices_new/.test(m[0]), `unexpected CREATE TABLE outside the rebuild: ${m[0]}`);
    }
  });

  test(`${rel}: request-path valve_actuation_expectations CREATE removed from both nodes`, () => {
    for (const id of ['zone-env-fn', 'get-actuations-query']) {
      const n = nodeById(fp, id);
      assert.ok(n, `${id} missing`);
      assert.ok(!/CREATE TABLE IF NOT EXISTS valve_actuation_expectations/.test(n.func),
        `${id} must not CREATE valve_actuation_expectations (seed-owned post-baseline)`);
    }
  });

  test(`${rel}: zone-env-fn KEEPS its OTHER request-path CREATEs (only valve_actuation_expectations is in scope)`, () => {
    const f = nodeById(fp, 'zone-env-fn').func;
    // verify-sync-flow.js requires zone_weather_cache to remain — the editor must
    // surgically remove ONLY the valve_actuation_expectations CREATE, not the array.
    assert.ok(/CREATE TABLE IF NOT EXISTS zone_weather_cache/.test(f),
      'zone_weather_cache CREATE must remain (verify-sync-flow depends on it)');
  });

  test(`${rel}: all three edited nodes still COMPILE (closes the get-actuations-query verifier gap)`, () => {
    for (const id of ['sync-init-fn', 'zone-env-fn', 'get-actuations-query']) {
      assertNodeCompiles(fp, id); // throws SyntaxError if the surgery broke the JS
    }
  });
}

test('both profiles keep sync-init-fn byte-identical', () => {
  assert.equal(nodeById(FLOW_PATHS[0], 'sync-init-fn').func, nodeById(FLOW_PATHS[1], 'sync-init-fn').func);
});
```

- [ ] **Step 1.2: Run it (red)**

```bash
node --test scripts/test-boot-ddl-removed.js 2>&1 | tail -5
```

Expected: FAIL — the DDL is still present. Record which tests fail (all the "NO …" ones). Do NOT commit yet.

---

### Task 2: The surgery — one-shot editor (both profiles) + baseline regen + CI

**Files:** Modify both `flows.json` (via script), `scripts/verify-no-stray-ddl-baseline.json`, `.github/workflows/migrations.yml`; commit the guard.

- [ ] **Step 2.1: Write the one-shot editor** to `/tmp/strip-boot-ddl.js`. It (a) extracts the `devices`-rebuild block VERBATIM from the current `sync-init-fn` func, (b) assembles a new func = read-only preamble + verbatim rebuild block, (c) removes the request-path CREATE from the two nodes. Because the exact byte-boundaries of the rebuild block depend on the current func text, the editor locates them by the block's stable landmarks and FAILS LOUDLY if it cannot (never silently produce a wrong node). Content:

```js
#!/usr/bin/env node
// One-shot: strip DDL from sync-init-fn (keep the devices rebuild + read-only
// reporting) and remove ONLY the request-path valve_actuation_expectations
// CREATE from the two nodes that carry it. Item 4.3 sub-step 2a.
// Run once, then cp bcm2712 -> bcm2709.
//
// SAFETY: every produced node body is COMPILE-VALIDATED (vm.Script, Node-RED's
// async-body wrap) before write; the rebuild block is BRACE-BALANCE-checked; the
// request-path removals are ELEMENT-TARGETED (the CREATEs live inside a template
// literal in get-actuations-query and inside a `migrations` array element in
// zone-env-fn — NOT bare statements — and zone-env-fn also holds unrelated CREATEs
// like zone_weather_cache that MUST remain). Any failure ABORTs without writing.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FLOW = path.resolve(process.cwd(),
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

const flows = JSON.parse(fs.readFileSync(FLOW, 'utf8'));
const byId = (id) => flows.find((n) => n.id === id);
const compiles = (func, id) => {
  try { new vm.Script(`(async function(msg){ ${func}\n})`, { filename: id }); return true; }
  catch (e) { console.error(`ABORT: ${id} would not compile: ${e.message}`); return false; }
};
const balanced = (s) => (s.match(/{/g) || []).length === (s.match(/}/g) || []).length
  && (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length;

// ---- (a) sync-init-fn: extract the devices-rebuild block, brace-balanced ----
const boot = byId('sync-init-fn');
if (!boot) { console.error('ABORT: sync-init-fn not found'); process.exit(1); }
const src = boot.func;
// The rebuild lives in a self-contained region. Locate it by its guard landmark
// (REQUIRED_TYPES) and grow the slice OUTWARD by whole lines until braces AND
// parens balance and the fail-closed shape is intact — deterministic, not a
// hand-tuned offset. Bounds are the line containing REQUIRED_TYPES's owning
// statement and the last foreign_keys=ON restore's line, then expanded to balance.
const lines = src.split('\n');
const gi = lines.findIndex((l) => l.includes('REQUIRED_TYPES'));
if (gi === -1) { console.error('ABORT: REQUIRED_TYPES landmark not found'); process.exit(1); }
let onLine = -1;
for (let i = lines.length - 1; i >= 0; i -= 1) { if (/foreign_keys\s*=\s*ON/i.test(lines[i])) { onLine = i; break; } }
if (onLine === -1) { console.error('ABORT: foreign_keys=ON restore not found'); process.exit(1); }
// Grow start upward and end downward until the slice is brace/paren balanced.
let a = gi; let b = onLine;
// walk start up to the nearest line that begins the rebuild's own statement/comment
while (a > 0 && !/^\s*(\/\/|const |let |if |try|_db\.transaction|PRAGMA)/.test(lines[a])) a -= 1;
let block = '';
for (let grow = 0; grow < 40; grow += 1) {
  block = lines.slice(a, b + 1).join('\n');
  if (balanced(block)) break;
  // extend end downward first (finally/catch closers usually follow the ON line)
  if (b + 1 < lines.length) b += 1; else if (a > 0) a -= 1; else break;
}
if (!balanced(block)) { console.error('ABORT: could not brace-balance the rebuild block'); process.exit(1); }
if (!/devices_new/.test(block) || /INSERT OR IGNORE INTO devices_new/.test(block)
    || !/foreign_keys\s*=\s*OFF/i.test(block) || !/foreign_keys\s*=\s*ON/i.test(block)) {
  console.error('ABORT: extracted rebuild block failed fail-closed self-check'); process.exit(1);
}

const PREAMBLE = [
  '// Sync Init — Option B Stage 2 (2a): DDL removed. Schema is owned by the',
  '// seed + ordered migrations, delivered by the deploy-time runner (Stage 1).',
  '// This node now only reports the schema state read-only for the heartbeat and',
  '// runs the guarded fail-closed devices-CHECK rebuild (kept ONE release as',
  '// belt-and-suspenders; removed in 2b). No ADD COLUMN sweep, no trigger',
  '// convergence, no writable_schema surgery.',
  'node.status({ fill: "green", shape: "dot", text: "schema: runner-owned" });',
  '',
  '// --- KEPT: guarded fail-closed devices-CHECK rebuild (PR #86; removed in 2b) ---',
].join('\n');
const newBoot = `${PREAMBLE}\n${block}\n`;
if (!compiles(newBoot, 'sync-init-fn')) process.exit(1);
// The rebuild block is executed by rehearse-devices-rebuild.test.js against the
// REAL shipped text — the ultimate proof the extraction preserved it.

// ---- (b) request-path removal: ELEMENT-TARGETED, per node ----
// get-actuations-query: the CREATE is `try { await exec(`CREATE ...`); } catch (_) {}`
//   — remove the whole try-block wrapping that one exec (matched by its template
//   literal), leaving surrounding logic intact.
function stripActuations(func) {
  const re = /try\s*\{\s*await exec\(`CREATE TABLE IF NOT EXISTS valve_actuation_expectations[\s\S]*?`\);\s*\}\s*catch\s*\([^)]*\)\s*\{[^}]*\}/;
  return func.replace(re, '/* valve_actuation_expectations is seed-owned (Stage 2); no request-path DDL */');
}
// zone-env-fn: the CREATE is ONE element of a `migrations` array of SQL strings.
//   Remove only that element (a quoted/backtick string starting with the CREATE),
//   preserving the array and its other elements (zone_weather_cache etc.).
function stripZoneEnv(func) {
  // Match a single array element: optional leading comma/newline, a template or
  // quoted string containing the CREATE, up to the element terminator (, or ]).
  const re = /,?\s*`CREATE TABLE IF NOT EXISTS valve_actuation_expectations[\s\S]*?`(?=\s*[,\]])/;
  return func.replace(re, '');
}
for (const [id, fn] of [['get-actuations-query', stripActuations], ['zone-env-fn', stripZoneEnv]]) {
  const n = byId(id);
  if (!n) { console.error('ABORT: ' + id + ' not found'); process.exit(1); }
  const before = n.func;
  const after = fn(before);
  if (after === before) { console.error(`ABORT: no valve_actuation_expectations CREATE removed from ${id} (regex missed — inspect the node)`); process.exit(1); }
  if (/CREATE TABLE IF NOT EXISTS valve_actuation_expectations/.test(after)) { console.error(`ABORT: ${id} still has the CREATE after removal`); process.exit(1); }
  if (id === 'zone-env-fn' && !/CREATE TABLE IF NOT EXISTS zone_weather_cache/.test(after)) { console.error('ABORT: zone-env-fn lost zone_weather_cache (over-matched)'); process.exit(1); }
  if (!compiles(after, id)) process.exit(1);
  n.func = after;
}

boot.func = newBoot;
if (!compiles(boot.func, 'sync-init-fn')) process.exit(1);
fs.writeFileSync(FLOW, JSON.stringify(flows, null, 2) + '\n');
console.log('OK: sync-init-fn DDL stripped (rebuild kept, compiled); request-path CREATE removed from 2 nodes (compiled, zone_weather_cache preserved)');
```

> **NOTE for the executing agent:** the request-path regexes above are anchored to the CURRENT node shapes (verified 2026-07-08: `get-actuations-query` wraps the CREATE in `try{ await exec(\`…\`) }catch`; `zone-env-fn` holds it as one element of a `migrations` array alongside `zone_weather_cache`/`gateway_locations`/`zone_shared_environment`, which MUST remain). The editor ABORTs (no write) if a regex misses, over-matches (loses `zone_weather_cache`), or any produced node fails to compile. If a node's shape has drifted, adjust the element-targeted regex to the new shape — never fall back to a broad `[\s\S]*?);` match (it corrupts template literals / array elements). Task 1's guard compile-checks all three nodes as the final net; `rehearse-devices-rebuild.test.js` proves the kept rebuild against the real text.

- [ ] **Step 2.2: Run it, mirror, clean up**

```bash
node /tmp/strip-boot-ddl.js \
  && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  && rm /tmp/strip-boot-ddl.js && echo MIRRORED
```

Expected: `OK: sync-init-fn DDL stripped …` then `MIRRORED`.

- [ ] **Step 2.3: Guard test green**

```bash
node --test scripts/test-boot-ddl-removed.js 2>&1 | tail -4
```

Expected: `# fail 0`.

- [ ] **Step 2.4: Update `verify-runtime-schema-parity.js` (REQUIRED — the trigger-convergence consequence, spec §merge-gate).** Verified gap: today (`verify-runtime-schema-parity.js:50-53`) it asserts the WHOLE flows.json text contains all **31** canonical trigger names by regex (`triggerNames(raw)` over the entire file). Removing the 30 `CREATE TRIGGER`s from `sync-init-fn` drops the flow's trigger set to **1** (`sync_dendro_to_readings`, in `dendro-compute-fn`) → this verifier would FAIL if unchanged. Change its trigger check so it no longer sources triggers from the flows text: the 31 canonical triggers are enforced by `verify-seed-replay.js` + `verify-db-schema-consistency.js` (the schema owners); `verify-runtime-schema-parity.js` keeps its `devices_new` CHECK parity (unchanged — the rebuild is kept) and its trigger check becomes "the one boot-created trigger `sync_dendro_to_readings` is present in the flows text" (i.e. compare `flowTriggers` against `{sync_dendro_to_readings}`, not `canonTriggers`). Keep the `canonDb`/`canonDevices` devices-CHECK logic exactly. Add a comment referencing this spec.

- [ ] **Step 2.5: FULL boot-node merge gate (the load-bearing gate)**

```bash
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js 2>&1 | tail -2
node scripts/verify-runtime-schema-parity.js
node scripts/verify-profile-parity.js
git fetch --no-tags origin main:refs/remotes/origin/main 2>/dev/null || true
node scripts/verify-no-stray-ddl.js
node scripts/verify-sync-flow.js 2>&1 | tail -1
```

Expected: `verify-devices-rebuild-fence: OK (2 flows)`; rehearse `4/4 pass` (proves the KEPT rebuild is byte-exact and still fail-closed); `verify-runtime-schema-parity: OK` **with the updated trigger check** (devices CHECK parity intact + `sync_dendro_to_readings` present); `All parity checks passed.`; `verify-no-stray-ddl.js` passes with **dropped** counts. Any RED other than an expected verifier-model change is a real regression — do not rationalize.

- [ ] **Step 2.6: Regenerate the stray-DDL baseline snapshot** (counts dropped; the snapshot is documentation, not the gate):

```bash
node scripts/verify-no-stray-ddl.js --write-baseline
git diff scripts/verify-no-stray-ddl-baseline.json | head -40
```

Expected: the flows.json `createTable`/`alterTable`/`createTrigger`/`dropTrigger`/`writableSchema` counts all DECREASED (removed the 93 ADD COLUMN sweep, 30+30 triggers, 2 writable_schema, 2 request-path CREATE). Confirm no count INCREASED.

- [ ] **Step 2.7: Wire the guard into CI + commit.** Append `scripts/test-boot-ddl-removed.js` to the `migrations.yml` scripts-test line, then:

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-boot-ddl-removed.js scripts/verify-runtime-schema-parity.js \
        scripts/verify-no-stray-ddl-baseline.json \
        .github/workflows/migrations.yml
git commit -m "feat(flows): Stage 2 (2a) — strip boot-node DDL + request-path DDL; keep devices rebuild (#88)"
```

---

### Task 3: Skill update + production-copy rehearsal + PR

**Files:** Modify `.claude/skills/osi-schema-change-control/SKILL.md`.

- [ ] **Step 3.1: Record the unfreezing in the skill.** In `.claude/skills/osi-schema-change-control/SKILL.md`, update the "Boot-DDL freeze" section: the freeze's purpose (make Stage 2 tractable) has been served; sub-step 2a has removed the sweep + inline DDL + request-path DDL; `sync-init-fn` now runs read-only reporting + the kept `devices` rebuild (removed in 2b). Update the "93 ADD COLUMN" factual count to reflect removal. Keep the sanctioned-exception description accurate for the 2a interim (rebuild still present). Do NOT delete the incident history.

- [ ] **Step 3.2: Production-copy rehearsal (spec §Rehearsal — OPERATOR step, per gateway).** For each gateway, on a fresh byte-copy of its DB post its Stage-1 migration to head: deploy the 2a flows to a throwaway Node-RED, boot, and confirm §Rehearsal steps 1–6 — especially: no boot DDL attempted; **all 31 triggers present** (30 runner-delivered + `sync_dendro_to_readings` boot-created by `dendro-compute-fn`); request path works without its CREATE; `devices` rebuild still fires on a drifted-CHECK copy; and GC's power-loss-mid-migration recovery via the runner alone. Record evidence. This is not a code task; it is the gate before the canary rollout.

- [ ] **Step 3.3: Commit the skill update**

```bash
git add .claude/skills/osi-schema-change-control/SKILL.md
git commit -m "docs(skill): record Stage 2 (2a) boot-node unfreezing; DDL removed, rebuild kept (#88)"
```

- [ ] **Step 3.4: Push branch and open the PR (do not merge until gates + rehearsal evidence)**

```bash
git push -u origin feat/88-stage2-boot-ddl-removal
gh pr create --title "feat(flows): Option B Stage 2 (2a) — remove boot-node DDL (#88)" --body "<body per below>"
```

PR body: (1) scope — Stage 2 sub-step 2a per the spec (link it); strips the ADD COLUMN sweep + inline/trigger DDL + writable_schema + request-path CREATE; **keeps the `devices` rebuild** (2b strips it next release); no schema/runner change; (2) the sanctioned-unfreezing statement + the full merge-gate verifier outputs from Step 2.4 (all green) + the dropped stray-DDL counts; (3) the trigger-convergence boundary (runner now owns the 30 triggers; the 31st stays boot-created) and that `verify-runtime-schema-parity` stays green; (4) **the gates GA–GD status** — this PR does NOT merge until they are green with evidence; (5) the per-gateway production-copy rehearsal evidence (all 31 triggers, power-loss recovery). Reference "Part of #88 (Stage 2)".

## Follow-ups (NOT tasks in this plan)

- **Sub-step 2b (one release after 2a ships fleet-wide):** a separate plan removes the `devices`-CHECK rebuild; `sync-init-fn` becomes purely read-only; `verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild.test.js` retired/repurposed (their subject is gone).
- **Canary rollout** (kaba100 → Silvan → Uganda) is an operator sequence under the 0.2 canary gate, after this PR's gates + rehearsals — not a plan task.
