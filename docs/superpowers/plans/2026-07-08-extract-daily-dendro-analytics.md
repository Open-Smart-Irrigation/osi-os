# Extract Daily Dendrometer Analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes:** (1) work inside a feature branch `feat/extract-dendro-analytics` (worktree recommended); (2) the `flows.json` edit is made ONLY via a one-shot Node script per `.claude/skills/osi-flows-json-editing/SKILL.md` — roundtrip guard before AND after, both profiles in the same run; (3) every file under `conf/` changes in BOTH profiles (bcm2712 canonical, bcm2709 mirror) in the same commit; (4) run every command from the repo/worktree root; (5) CI green at every commit.
> **Spec:** [`docs/superpowers/specs/2026-07-08-extract-daily-dendro-analytics-design.md`](../specs/2026-07-08-extract-daily-dendro-analytics-design.md) (approved — this plan elaborates, it does not redesign). §A–§E references point there.
> **Charter:** `docs/architecture/refactor-program-2026.md` Phase 2, item 2.2 (DD4 first seam). **Depends on 1.A1 (osi-lib loader) and 1.A2 (size ratchet) being merged** — this plan assumes `osi-lib/`, `verify-helper-registration.js`, and `verify-flows-size-ratchet.js` exist on the base branch. If they do not, STOP: 2.2 cannot land before its dependencies.

**Goal:** Extract the pure compute core of `flows.json` node `dendro-compute-fn` (Daily Dendrometer Analytics, 57,047 chars) into a new tested `osi-dendro-analytics` module loaded via `osiLib.require`, leaving DDL + SQL I/O + HTTP orchestration in the residual node, with behavior pinned by golden vectors captured from the CURRENT node before the change, and the flows.json size scoreboard measurably decreased.

**Architecture:** New pure-Node module `conf/<profile>/files/usr/share/node-red/osi-dendro-analytics/` (`index.js` + `package.json` + co-located `index.test.js`), zero deps, exporting the §A pure functions. Registered in `osi-lib` `NAME_TO_PATH` (`'dendro-analytics'`) + all three delivery surfaces, gated by `verify-helper-registration.js`. The residual `dendro-compute-fn` keeps its `MIGS` DDL block, all SQL read/write, and the weather-HTTP integration; it calls the module's functions via `osiLib.require('dendro-analytics').value.*`. Golden vectors are captured by executing the **pre-extraction** node body against a `node:sqlite` fixture DB via the `rehearse-devices-rebuild.js` facade-shim technique (spec §D), then the post-extraction node is asserted to reproduce identical DB writes.

**Tech Stack:** Node.js only (`node --test`, `node:sqlite` — needs Node ≥22.5; CI runs Node 22). No new deps. CI: `.github/workflows/migrations.yml`.

## Global Constraints

- **Behavior-preserving extraction only.** No compute change. A golden vector that reveals a latent bug is documented, not fixed here (separate later PR — program Risks).
- **The `MIGS` DDL block is untouched** — not moved, reordered, or altered. `verify-no-stray-ddl.js`'s flows.json marker count (351/profile) MUST be unchanged after the extraction (the node contributes 91 markers; moving only compute text leaves them inline).
- **New module is a separate directory** `osi-dendro-analytics/` — NOT merged into `osi-dendro-helper` (spec §ground-truth 2; that is the unrelated per-uplink decoder).
- **`irrDecision` moves with its ambient inputs parameterized** (`computedAt`, `nowMs`, `opts.log`) — spec §B; the adapter supplies today's exact values.
- **Both profiles byte-parity** for every changed `conf/` file (`verify-profile-parity.js`). Frozen `sync-init-fn` untouched.
- **No SSH, no live gateway, no production host.** All tests run locally/CI against fixtures.
- Branch `feat/extract-dendro-analytics`, commit per task, open a PR at the end, **do not merge it**.

## Verification findings (plan-write checks; report, don't silently patch)

1. **The node's exact impure/pure split is verified** (spec §ground-truth 3–4, re-confirmed): `irrDecision` is the ONLY function among the 29 extraction candidates that references `node.*`/`Date.now()`/`COMPUTED_AT`/argument-mutation. The other 28 (all math/stats + the `Intl`-based time helpers that take an explicit `ts`) are context-free. No `flow.get`/`global.get`/`context.` anywhere in the node — no Node-RED global-context dependency to break the pure boundary.
2. **The node opens the DB via `new osiDb.Database('/data/db/farming.db')` and uses a promise wrapper (`q`/`run`/`close`).** The facade-shim harness (Task 2) must expose the same `osiDb.Database` surface (constructor → object with `all`/`run`/`close`), which `rehearse-devices-rebuild.js`'s `makeFacadeShim` already models over `node:sqlite`.
3. **The node makes outbound HTTP** (`requestJson` → weather auth/token, history/hourly, open-meteo) via bare `require('https')/require('http')` (Node builtins — exempt from 1.A1's bare-require ban). These stay adapter-side and are STUBBED in the vector harness so the compute is deterministic (spec §D-2).
4. **`docs/contracts/dendro/` does not exist yet** — this plan creates it (Task 4).
5. **The `MIGS` DDL text must not appear in the extracted module** — the module is pure compute; if any DDL string moves, `verify-no-stray-ddl.js` would see the flows.json count DROP (markers left the flows file), failing the "unchanged" constraint. The mutation script (Task 5) asserts the node still contains its DDL markers post-edit.

## File Structure (all changes)

- Create (both profiles): `conf/<profile>/files/usr/share/node-red/osi-dendro-analytics/{index.js, package.json, index.test.js}` (T1)
- Modify (both profiles): `osi-lib/index.js` (`NAME_TO_PATH` += `'dendro-analytics'`), runtime `package.json` + `package-lock.json`, `98_osi_node_red_seed`; Modify `deploy.sh` (fetch pair) (T3)
- Create: `scripts/capture-dendro-analytics-vectors.js` (harness, not shipped to Pi) (T2)
- Create: `docs/contracts/dendro/{README.md, MANIFEST.json, cases/*.input.json, cases/*.expected.json}` (T4)
- Modify (both profiles): `conf/<profile>/files/usr/share/flows.json` — node `dendro-compute-fn` only (T5)
- Modify: `.github/workflows/migrations.yml` (T6), `docs/architecture/refactor-program-2026.md` (T7)

---

### Task 1: `osi-dendro-analytics` module + per-function `node --test` (compute core, extracted verbatim)

**Files:** Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/{index.test.js, index.js, package.json}`; mirror to bcm2709.

**Interfaces:** `require('osi-dendro-analytics')` → `{ round, avg, percentile, median3, detectJumps, removeJumps, extractExtremes, computeVPD, buildQaFlags, computeEnvelope, classifyAbsoluteTwd, carryForwardState, computeAbsoluteDeltaTwdSmoothed, computeRDelta5day, adjustStress, computeR2, aggregateZoneStress, dendroThresholdStressLevel, decisionEscalationStress, applyDendroSchedulePolicy, irrDecision, localHour, localTimeStr, localDateParts, shiftDateIso, tzOffsetMinutes, localMidnightUtcIso, computeZoneDayWindow, calibrationForKey, CONSTANTS }` plus the closed-over constants (`RANK`, `PHENO_MOD`, `LEVELS`, `MIN_SAMPLES_DAY`, `MIN_SAMPLES_WINDOW`, `LOW_SIGNAL_THRESHOLD_UM`, `JUMP_THRESHOLD_UM`, `N_TREES_FOR_EMERGENCY`, `DAYS_FOR_SOLO_EMERGENCY`, `CALIBRATIONS`).

- [ ] **Step 1.1: Extract the function bodies verbatim from the current node.** Read `dendro-compute-fn`'s `func` from `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`. Copy the 28 pure function declarations + the module-level constants they close over into `osi-dendro-analytics/index.js` **byte-for-byte** (same names, same bodies) under `'use strict';`, then `module.exports = { ...all names... }`. The constants that were `const`s in the node become module-level `const`s in the file. **Do not edit any function body** — verbatim copy is the behavior-preservation guarantee.

- [ ] **Step 1.2: Move `irrDecision` with the three parameterizations (spec §B) — the ONE edited function.** In the module copy of `irrDecision`:
  - Replace the free reference to `COMPUTED_AT` with a parameter: add `computedAt` to the options the function receives (the node calls it as `irrDecision(hist3, rain, zs, nonRef)` today; extend the signature to `irrDecision(hist3, rain, zs, nonRef, opts = {})` and read `const computedAt = opts.computedAt;`). Replace `zs.rain_suppression_start = COMPUTED_AT;` with `zs.rain_suppression_start = computedAt;`.
  - Replace `Date.now()` (in the elapsed-hours calc) with `const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();` and use `nowMs`.
  - Replace `node.log('Zone: rain suppression exited — TWD responded');` with `const log = typeof opts.log === 'function' ? opts.log : function () {}; log('Zone: rain suppression exited — TWD responded');`.
  - The `zs`-mutation stays (documented in-out param). Nothing else in `irrDecision` changes. This is the only function whose text differs from the node; §D-1's vector for the rain-suppression-exit branch pins that the `log` callback fires with the same message.

- [ ] **Step 1.3: Write co-located per-function `node --test` vectors** — `osi-dendro-analytics/index.test.js`, one `test(...)` per exported function, asserting representative `(inputs) → output` pairs. Derive inputs from the current node's real usage (e.g. `computeEnvelope([{dMax,dMin},...], 'stepwise')`, `aggregateZoneStress([{twd_day_um, tree_state_v5, confidence_score, low_confidence_day},...])`, `computeR2(x, y)`, `classifyAbsoluteTwd(twdDayUm, phenoMod, calibration)`, `irrDecision(hist3, rain, zs, nonRef, {computedAt, nowMs, log})` — include a case that trips the rain-suppression-exit branch and asserts the captured `log` fired). These vectors are the module's own regression net; capture the expected outputs by running the just-extracted functions (they are verbatim copies, so their output IS the behavior contract).

- [ ] **Step 1.4: `package.json`:**
```json
{ "name": "osi-dendro-analytics", "version": "1.0.0", "private": true, "main": "index.js" }
```

- [ ] **Step 1.5: Run the suite — expect PASS:**
```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/index.test.js
```

- [ ] **Step 1.6: Mirror to bcm2709 + parity:**
```bash
cp -a conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-dendro-analytics
node scripts/verify-profile-parity.js
```

- [ ] **Step 1.7: Commit**
```bash
git add conf/*/files/usr/share/node-red/osi-dendro-analytics
git commit -m "feat(edge): osi-dendro-analytics pure module (compute core of Daily Dendro) + node --test (refactor-program 2.2, spec §A/§B)"
```

---

### Task 2: Golden-vector capture harness (run the CURRENT node against a node:sqlite fixture DB)

**Files:** Create `scripts/capture-dendro-analytics-vectors.js` (harness only, not shipped to the Pi — lives in `scripts/`).

**Interface:** CLI: `node scripts/capture-dendro-analytics-vectors.js --capture` (reads the CURRENT node from flows.json, runs it against the seeded fixture DB with stubbed weather, snapshots output rows into `docs/contracts/dendro/cases/`) and `--verify` (runs the CURRENT-on-disk node against the same seed and asserts equality with the committed snapshot — used post-extraction to prove the residual node still matches).

- [ ] **Step 2.1: Build the harness on the `rehearse-devices-rebuild.js` pattern** (spec §D, §ground-truth 5). Reuse its `makeFacadeShim(dbPath)` over `node:sqlite`'s `DatabaseSync`, exposing the `osiDb.Database`-compatible surface the node uses (constructor returning `{ all, run, close }`). Seed the DB from `database/seed-blank.sql` plus fixture rows for 2–3 zones covering: a healthy tree, a stressed tree, a reference tree, a low-confidence (few-samples) tree, and a missing-data tree. Read the node's `func` via `JSON.parse(fs.readFileSync(FLOWS,'utf8')).find(n => n.id === 'dendro-compute-fn').func`.

- [ ] **Step 2.2: Stub the weather HTTP deterministically.** The node's `requestJson` calls a weather API; provide the node a sandbox where `require('https')`/`require('http')` are replaced (or where `requestJson`'s inputs are pre-satisfied) so no live call is made and VPD-related inputs are fixed constants. Because the weather integration is adapter-side and out of the compute contract (spec §D-2, Non-goals), the stub returns a fixed hourly series so the compute is deterministic. Run the node body inside a `vm`/`Function` sandbox with the same globals Node-RED provides (`node` = a stub with `log`/`error`/`status`/`warn`; `osiDb` = the facade; `msg` = `{}`; `env` = a stub; and for the current node, `osiLib` = a stub whose `require` returns the not-yet-existent module for the `--capture` run, OR — simpler — `--capture` runs the PRE-extraction node which does NOT use osiLib, so no stub needed; `--verify` runs the POST-extraction node which DOES, so its `osiLib` stub returns the real `osi-dendro-analytics`).

> Worker note: the `--capture` snapshot MUST be taken from the node as it exists BEFORE Task 5 edits it (the pre-extraction body). Capture in this task, commit the fixtures in Task 4, then Task 5 edits the node, then `--verify` proves the edited node reproduces the committed snapshot. Order matters — this is the behavior-preservation LAW.

- [ ] **Step 2.3: Snapshot the output rows.** After running the node against the seed, `SELECT` the resulting `dendrometer_daily` and `zone_daily_recommendations` (and `zone_irrigation_state` if written) rows, normalize (drop `computed_at` timestamps or pin them via the fixed `computedAt`), and write them as `docs/contracts/dendro/cases/<case>.expected.json`; write the seed rows as `<case>.input.json`. (Task 4 formalizes the directory + README + MANIFEST.)

- [ ] **Step 2.4: Prove `--capture` and `--verify` agree on the CURRENT node** (before any extraction): run `--capture` then `--verify` back-to-back against the unedited node; `--verify` must pass (self-consistency check of the harness). Commit the harness.
```bash
node scripts/capture-dendro-analytics-vectors.js --capture
node scripts/capture-dendro-analytics-vectors.js --verify   # green against the pre-extraction node
git add scripts/capture-dendro-analytics-vectors.js
git commit -m "feat(ci): dendro-analytics golden-vector capture/verify harness (node:sqlite facade shim) (refactor-program 2.2, spec §D)"
```

---

### Task 3: Register `osi-dendro-analytics` in osi-lib NAME_TO_PATH + all three delivery surfaces

**Files:** Modify (both profiles) `osi-lib/index.js`, runtime `package.json` + `package-lock.json`, `98_osi_node_red_seed`; Modify `deploy.sh`.

- [ ] **Step 3.1: `osi-lib` NAME_TO_PATH.** In `conf/<profile>/files/usr/share/node-red/osi-lib/index.js`, add to `NAME_TO_PATH`: `'dendro-analytics': 'osi-dendro-analytics',` (a non-codec entry → `verify-helper-registration.js` will enforce its three surfaces). Both profiles, byte-identical.

- [ ] **Step 3.2: Runtime `package.json` + `package-lock.json`** (scripted, roundtrip-guarded — reuse the `register-modules.js` pattern from the 1.A1 plan Task 2, with `NEW_MODULES = ['osi-dendro-analytics']`): add `"osi-dendro-analytics": "file:osi-dendro-analytics"` to `dependencies`; add the three lock entries (root dep, `node_modules/osi-dendro-analytics` link, version entry).

- [ ] **Step 3.3: Seed loop.** In `98_osi_node_red_seed`, add `osi-dendro-analytics` to the module-copy `for module in ...` list (both profiles).

- [ ] **Step 3.4: `deploy.sh` fetch pair** (helper-fetch section only), after another helper's block:
```bash
fetch_required "osi-dendro-analytics package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/package.json" \
    "/srv/node-red/osi-dendro-analytics/package.json"
fetch_required "osi-dendro-analytics index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/index.js" \
    "/srv/node-red/osi-dendro-analytics/index.js"
```

- [ ] **Step 3.5: Mirror bcm2712 → bcm2709 for every changed file; verify + commit:**
```bash
node scripts/verify-profile-parity.js
node scripts/verify-helper-registration.js   # osi-dendro-analytics now green across all three surfaces
git add -A conf deploy.sh
git commit -m "feat(edge): register osi-dendro-analytics in osi-lib NAME_TO_PATH + three delivery surfaces (refactor-program 2.2, spec §E)"
```

---

### Task 4: Formalize `docs/contracts/dendro/` (README + MANIFEST + cases)

**Files:** Create `docs/contracts/dendro/README.md`, `MANIFEST.json`, and confirm `cases/*.input.json` / `*.expected.json` from Task 2 are in place.

- [ ] **Step 4.1: README** (mirror the `docs/contracts/sync-schema/README.md` convention): state osi-os is the source of truth, that item 2.3 defines the cross-repo mirror + byte-parity gate, and that these fixtures are input-rows→expected-edge-outputs captured from the pre-extraction node. Note the field names are the shared `dendrometer_daily` snake_case columns (channels.json truth).

- [ ] **Step 4.2: `MANIFEST.json`** — an ordered list of case names + a `schemaVersion` integer, so 2.3's cross-repo runner enumerates cases deterministically.

- [ ] **Step 4.3: Commit** the contract fixtures (they are the behavior-preservation artifact):
```bash
git add docs/contracts/dendro
git commit -m "feat(contract): docs/contracts/dendro golden-vector fixtures captured from the pre-extraction node (refactor-program 2.2, spec §D; consumed by 2.3)"
```

---

### Task 5: Flows migration — remove the compute core from the node, call the module

**Files:** Modify (via one-shot mutation script, both profiles) `conf/<profile>/files/usr/share/flows.json` — node `dendro-compute-fn` ONLY.

- [ ] **Step 5.1: Write the one-shot mutation script** (scratchpad, not repo; roundtrip guard before/after per the flows skill). The script:
  - loads flows, roundtrip-guards, finds `dendro-compute-fn`, asserts `node.name === 'Daily Dendrometer Analytics'`.
  - **Removes** the 28 pure function declarations + their constants from the node's `func` (they now live in the module). Removes `irrDecision`'s old inline body.
  - **Inserts** near the top of the async IIFE (after `osiDb` open but the module load can precede DB open): `const _daLoad = osiLib.require('dendro-analytics'); if (!_daLoad.ok) { node.error('Daily Dendro Analytics: analytics module unavailable: ' + _daLoad.error, msg); node.status({fill:'red',shape:'ring',text:'analytics module unavailable'}); return null; } const DA = _daLoad.value;` (spec §E load-failure path).
  - **Rewrites moved-function call sites** so `computeEnvelope(...)` → `DA.computeEnvelope(...)`, `aggregateZoneStress(...)` → `DA.aggregateZoneStress(...)`, `irrDecision(hist3, rain, zs, nonRef)` → `DA.irrDecision(hist3, rain, zs, nonRef, { computedAt: COMPUTED_AT, nowMs: Date.now(), log: (m) => node.log(m) })`, etc. — for every extracted function. **Use word-boundary / call-shaped matching, not naive `String.replace`** — terse names (`round`, `avg`, `n`, `s`) will over-match (`Math.round`, `WINDOW_…`, identifiers containing the substring). Match `(?<![\w$.])round\s*\(` (call site, not member access, not identifier suffix) and rewrite to `DA.round(`; the `(?<![\w$.])` lookbehind is the same false-positive guard the 1.A1 bare-require ratchet uses. Prefer rewriting to `DA.<name>` over adapter-local re-declaration to avoid duplication.
  - **Rewires the 5 moved-CONSTANT reference sites the adapter body reads directly** (verified present in the current node's top-level body, outside the moved functions): `PHENO_MOD`, `MIN_SAMPLES_DAY`, `LOW_SIGNAL_THRESHOLD_UM`, `CALIBRATIONS`, `RANK`. Export these from the module (add to `module.exports`) and rewrite each adapter reference to `DA.PHENO_MOD` / `DA.MIN_SAMPLES_DAY` / `DA.LOW_SIGNAL_THRESHOLD_UM` / `DA.CALIBRATIONS` / `DA.RANK` (word-boundary matched). If the script deletes a constant's declaration without rewiring these sites, the node throws `ReferenceError` at runtime — the post-condition below catches it pre-commit, and `--verify` (Step 5.3) is the final safety net.
  - adds `{"var":"osiLib","module":"osi-lib"}` to the node's `libs` (alongside the existing `osiDb`).
  - **Post-conditions asserted by the script (fail = STOP):** (a) the node's `func` still contains every `MIGS` DDL marker (grep the func for `CREATE TABLE`/`ALTER TABLE`/`CREATE INDEX`/`CREATE TRIGGER`/`DROP TRIGGER` counts == the pre-edit counts — the DDL is untouched, 91 markers stay inline); (b) no extracted pure-function *declaration* remains (`function computeEnvelope(` … absent for all 29 names); (c) **no un-prefixed reference to any moved function OR moved constant remains** — for each of the 29 function names and 5 constant names, assert every occurrence in the post-edit `func` is either a `DA.`-prefixed member access or (for the constants passed into `DA.irrDecision`, e.g. `COMPUTED_AT` which is NOT moved) an intentionally-retained adapter local; concretely, assert zero matches of `(?<![\w$.])(computeEnvelope|aggregateZoneStress|…|PHENO_MOD|MIN_SAMPLES_DAY|LOW_SIGNAL_THRESHOLD_UM|CALIBRATIONS|RANK)\s*[\(\[.]` that are not immediately preceded by `DA.`; (d) `sync-init-fn` untouched; (e) zero bare non-builtin `require(` introduced. Note: `COMPUTED_AT` and `NOW` are wall-clock captures that STAY in the adapter (they are passed into `DA.irrDecision` as `computedAt`/`nowMs`), so they are NOT in the moved-name list and their adapter references are expected.
  - writes both profiles, post-write roundtrip guard.

- [ ] **Step 5.2: Run the mutation; then run the size ratchet to confirm the scoreboard dropped:**
```bash
node /tmp/claude-*/…/scratchpad/migrate-dendro-node.js
node scripts/verify-flows-size-ratchet.js   # total DECREASED vs origin/main (the DD4 win); NOTE line ok
node scripts/verify-no-stray-ddl.js         # UNCHANGED (DDL stayed inline) — 351/profile
```

- [ ] **Step 5.3: Prove behavior preservation — the residual node reproduces the committed golden vectors:**
```bash
node scripts/capture-dendro-analytics-vectors.js --verify   # POST-extraction node == committed snapshot
```
If `--verify` fails, the extraction changed behavior — STOP, diff the failing case's fields, and fix the adapter wiring (do NOT edit the fixture; the fixture is the pre-extraction truth).

- [ ] **Step 5.4: Full flows pre-commit checklist:**
```bash
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
bash scripts/check-mqtt-topics.sh
```

- [ ] **Step 5.5: Commit**
```bash
git add conf/*/files/usr/share/flows.json
git commit -m "refactor(edge): extract Daily Dendro compute core to osi-dendro-analytics; residual node = DDL+SQL+HTTP only (refactor-program 2.2, spec §A/§C; behavior pinned by golden vectors)"
```

---

### Task 6: CI wiring

**Files:** Modify `.github/workflows/migrations.yml`.

- [ ] **Step 6.1:** Add the module test to the `node --test` line: append `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/index.test.js`. Add a run line for the vector verify: `- run: node scripts/capture-dendro-analytics-vectors.js --verify` (runs against the committed post-extraction node + committed fixtures — the standing behavior-preservation regression gate).

- [ ] **Step 6.2: Verify + commit:**
```bash
node -e "const y=require('fs').readFileSync('.github/workflows/migrations.yml','utf8'); if(!y.includes('osi-dendro-analytics')||!y.includes('capture-dendro-analytics-vectors')) throw new Error('not wired'); console.log('wired')"
git add .github/workflows/migrations.yml
git commit -m "feat(ci): wire osi-dendro-analytics tests + golden-vector verify into Edge Migrations (refactor-program 2.2)"
```

---

### Task 7: Program-doc DD4 refinement + outcome, PR

- [ ] **Step 7.1:** In `docs/architecture/refactor-program-2026.md`: (a) in the DD4 row, append the honest refinement: `("adapter <~2 KB" applies to routing-shaped seams; for I/O-heavy seams — daily-batch/HTTP-shaped — the bar is "zero inline compute/business logic remains," the residual being DDL+SQL+HTTP orchestration; established by item 2.2)`; (b) in the Phase 2 table, append to the 2.2 row: `— done: osi-dendro-analytics extracted (compute core), golden-vectored, scoreboard decreased, PR #<FILL>`.
```bash
git add docs/architecture/refactor-program-2026.md
git commit -m "docs(program): DD4 refinement for I/O-heavy seams + record 2.2 outcome"
```

- [ ] **Step 7.2: Full local CI-equivalent run** (all green): the module test, the vector `--verify`, `verify-helper-registration.js`, `verify-flows-size-ratchet.js` (total dropped), `verify-no-stray-ddl.js` (unchanged), `verify-profile-parity.js`, `verify-sync-flow.js`, `test-flows-wiring.js`.

- [ ] **Step 7.3: Open the PR (do not merge)** — title `Extract Daily Dendrometer Analytics → osi-dendro-analytics (refactor-program 2.2)`; body: summary of the compute-core extraction, the DDL-stays/HTTP-stays boundary, the `irrDecision` parameterization, the golden-vector proof (`--verify` green), the scoreboard decrease, and the DD4 refinement. Note dependencies 1.A1/1.A2 must be merged first; note 2.3 consumes `docs/contracts/dendro/`.

---

## Follow-ups (not tasks in this plan)

- **Item 2.3** turns `docs/contracts/dendro/` into the cross-repo contract (osi-server mirror + byte-parity gate + `DendroContractFixtureTest`).
- **Item 2.4** (Zone Env Summary) reuses this exact extraction pattern for the next HTTP-shaped seam.
- Any latent bug a golden vector reveals is a separate behavior-change PR (program Risks), never folded into this behavior-preserving extraction.
