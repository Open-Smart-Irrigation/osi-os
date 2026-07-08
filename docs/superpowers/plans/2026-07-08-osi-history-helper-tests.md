# Co-locate `node --test` for `osi-history-helper` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes:** (1) work inside a feature branch `feat/osi-history-helper-tests` (worktree recommended); (2) this plan touches NO `flows.json` node and moves NO *module* code — it RELOCATES an existing test suite to sit beside the already-extracted module and rewires CI; (3) the module already exists in BOTH profiles (bcm2712 canonical, bcm2709 mirror) — the co-located test file is created in both in the same commit; (4) run every command from the repo/worktree root; (5) CI green at every commit.
> **No spec.** This is the LEAN-PLAN item (refactor-program item 1.A3, `M`). It is a test-**co-location** item over an existing 105 KB module and needs no design doc — the design decision ("re-home the existing coverage beside the module for DD4's 'done' leg; do NOT re-derive vectors") is stated inline below.
> **Charter:** `docs/architecture/refactor-program-2026.md` — item 1.A3 (line 67): "Backfill `node --test` for the existing `osi-history-helper` (pattern proof for DD4's 'done')," **Depends on 1.A1**. DD4's "done" leg (line 31) is a **co-located** `node --test` green in CI. The charter's stated deficiency (line 14) is precisely "**no co-located tests**" — NOT "no tests." This item is the **done-definition pattern proof**: it makes the co-located `node --test` leg real against a live shipped module before the 2.x/4.x seams must produce their own. It is deliberately the smallest item in batch-B and is sequenced FIRST to de-risk the pattern.
> **Depends on 1.A1** (osi-lib loader, kills #99) being merged — matching the charter's dependency edge. 1.A1 does not change `osi-history-helper`'s *content*, only its load path from function nodes; this test-relocation does not require 1.A1's code, but the charter sequences 1.A3 after 1.A1. If 1.A1 is unmerged, coordinate ordering; the test relocation itself has no hard code dependency on it (state this in the PR).

**Goal:** Give `osi-history-helper` a **co-located** `node --test` suite (`osi-history-helper/index.test.js`, both profiles) so DD4's "co-located `node --test` green in CI" leg is satisfied for the already-extracted module, by **re-homing the existing comprehensive suite** (`scripts/test-history-helper.js`) beside the module and rewiring CI — **NOT** authoring net-new golden vectors. No refactor of `index.js` or `analysis.js`. No new module, no `flows.json` edit, no DDL, no schema change.

**Architecture:** `osi-history-helper` is an already-extracted, already-registered helper (`conf/<profile>/files/usr/share/node-red/osi-history-helper/`) consumed by `history-api-router-fn` (16 distinct `osiHistory.*` methods), `history-rollup-tick-fn`, `analysis-api-router-fn`, and the `*-history-fn` nodes. It is **already tested** by `scripts/test-history-helper.js` (2138 lines, `node:test` API, CI-wired at `migrations.yml:39` as `node scripts/test-history-helper.js`) — which `require()`s the real bcm2712 module, seeds a `node:sqlite` fixture from `database/seed-blank.sql`, and pins every export incl. `kpaToPf` golden vectors and the SWT-pF paired-export contract. The gap DD4 names is **location**: that suite lives under `scripts/`, not *beside the module*, so it does not satisfy the "co-located `node --test`" bar the 2.x/4.x seams must each meet. This plan relocates it to `osi-history-helper/index.test.js` (importing the module via a relative `./index.js` path, the co-located convention `osi-lib/index.test.js` uses), makes it `node --test`-invokable, wires CI to run it in place, and retires the `scripts/` copy — establishing the exact "co-located golden-vector `node --test`" template 2.4 and 4.2 reuse.

**Tech Stack:** Node.js only (`node --test` / `node:test`, Node ≥22 — CI runs Node 22; `node:sqlite` needs ≥22.5, already used by the existing suite). No new deps. CI: `.github/workflows/migrations.yml`.

## Global Constraints

- **No refactor of the module, no behavior change.** `index.js` and `analysis.js` are NOT edited. The relocated suite must keep asserting the CURRENT shipped behavior (behavior-preservation LAW — the vectors were captured from shipped code). If a test reveals a latent bug during relocation, it is documented (a `// KNOWN:` note preserving the current assertion), not fixed here — a fix is a separate later PR (program Risks).
- **Do NOT re-derive or duplicate vectors.** The existing `scripts/test-history-helper.js` already covers the surface (verified below). The work is RELOCATION, not authorship. A second parallel copy of the same vectors is explicitly out of scope — the `scripts/` copy is retired, not kept alongside.
- **Co-located tests.** The suite lives beside the module (`osi-history-helper/index.test.js`), matching the DD4 "co-located `node --test`" bar and the `osi-lib/index.test.js` precedent — NOT under `scripts/`.
- **Both profiles byte-parity.** The relocated test file is created identically in `bcm2712` (canonical) and `bcm2709` (mirror); `verify-profile-parity.js` stays green. (Note: the existing `scripts/` suite hard-codes the bcm2712 module path; after relocation each profile's copy imports its OWN sibling `./index.js` — see Task 1.)
- **No SSH, no live gateway, no production host.** All tests run locally/CI against fixtures.
- Branch `feat/osi-history-helper-tests`, commit per task, open a PR at the end, **do not merge it**.

## Verification findings (plan-write checks against real HEAD `f05b82ab`, 2026-07-08 — report, don't silently patch)

1. **The module is ALREADY tested — the premise is "co-locate," not "backfill from nothing."** `scripts/test-history-helper.js` (2138 lines, 93 KB) exists, is CI-wired at `.github/workflows/migrations.yml:39` (`- run: node scripts/test-history-helper.js`), passes green, uses the `node:test` `test('…', …)` API, `require()`s the real bcm2712 `osi-history-helper` module, seeds a real SQLite fixture from `database/seed-blank.sql` via a `{all, run}` handle, and exercises the full export surface — the 6 classifiers, `kpaToPf` (contract golden vectors at line 1355: `kpaToPf(10)≈2`, `kpaToPf(30)≈2.477…`, `kpaToPf(60)≈2.778…`, `kpaToPf(300)≈3.477…`, `(0)→null`, `(-4)→null`), the SWT-pF paired-export contract (`swt_1`/`swt_1_pf` rows, lines ~1323/1349), `deriveCards*`, CSV builders, `aggregateRows`/`aggregateDeviceData`, the db-backed functions (`legacySensorHistory`, `legacyRainDailyHistory`, `runRollupJob`, `upsertRollups`, `computeRollupBuckets`, `writeZoneCsv`, `rotateZoneCsv`), and the analysis-factory outputs (`buildAnalysisCatalog`, `listAnalysisViews`, `resolveAnalysisSeries`, `saveAnalysisView`). **This is the suite to relocate.**
2. **Module layout confirmed.** `osi-history-helper/` contains `index.js` (2622 lines, `module.exports` at line 2583), `analysis.js` (474 lines), `package.json` (`{"name":"osi-history-helper","main":"index.js"}`). `index.js:4` = `const { createAnalysis } = require('./analysis')`; the analysis exports are re-exported through `index.js`'s `module.exports` (`ANALYSIS_VIEWS_SCHEMA`, `analysisSeriesId`, `buildAnalysisCatalog`, `listAnalysisViews`, `resolveAnalysisSeries`, `saveAnalysisView` from `analysis.<name>`). **No `*.test.js` exists in the module directory today** — that absence IS the gap. The bcm2709 module is byte-identical to bcm2712.
3. **The public surface = `index.js`'s `module.exports` (38 exports, verified list, already all covered by the existing suite).** The relocation must preserve coverage of every export; the existing suite already does (its `expectedExports` list is asserted). The exact set: `normalizeDeveui, ANALYSIS_VIEWS_SCHEMA, analysisSeriesId, buildAnalysisCatalog, listAnalysisViews, resolveAnalysisSeries, saveAnalysisView, deriveCardId, deriveCardsForZone, deriveGatewayCard, resolveAggregation, kpaToPf, classifySoilStatus, classifySoilDay, classifyEnvironmentStatus, classifyDendroStatus, classifyIrrigationStatus, classifyGatewayStatus, deriveExpectedCadenceSeconds, legacySensorHistory, legacyRainDailyHistory, resolveDeviceFieldRollupKey, runRollupJob, upsertRollups, computeRollupBuckets, startOfLocalDayMs, buildZoneExportCsv, RAW_CSV_COLUMNS, AGG_CSV_COLUMNS, toCsv, writeZoneCsv, rotateZoneCsv, aggregateRows, aggregateDeviceData, buildAdvancedMetadataPlaceholder, buildAdvancedDiagnostics, buildCalendar, buildLocalInterpretations`.
4. **CI invocation style:** `migrations.yml` mixes `node --test <files>` (e.g. lines 37, 38, 40, 49, 50, 52) and `node <file.js>` (line 39 for this suite, which has its own top-level exec/`process.exitCode`). After relocation the co-located suite should be run as `node --test conf/…/osi-history-helper/index.test.js` (the DD4-mandated invocation, matching the other `node --test` lines) — confirm the relocated file is a pure `node:test` file with no self-exec that would double-run under `--test`.
5. **`analysis.js` is a `createAnalysis(deps)` factory** (line 261) closing over 9 injected deps (`aggregateRows, dbAll, deriveCardsForZone, displayDeviceName, normalizeDeveui, resolveAggregation, soilDepthCm, sourceDevicesForCard, sourceKeyForCsv`) and returning **6 keys** (`ANALYSIS_VIEWS_SCHEMA, analysisSeriesId` + `buildAnalysisCatalog, listAnalysisViews, resolveAnalysisSeries, saveAnalysisView`). Note `analysis.js` has a module-internal `dbRun` (line 143) used by the write paths (`saveAnalysisView`/`listAnalysisViews`) — those are exercised via the fixture DB, not a stub, in the existing suite (preserve that).
6. **`ANALYSIS_VIEWS_SCHEMA` (analysis.js line 38) is a `CREATE TABLE analysis_views` string constant in a helper file** — OUTSIDE `verify-no-stray-ddl.js` scope (which scans only the two `flows.json` profiles + `deploy.sh`, per its `DEFAULT_SURFACES`), so relocation has zero interaction with the DDL ratchet.
7. **This item touches NO `flows.json`, NO `osi-lib`, NO `deploy.sh`, NO seed loop, NO schema/migration** — the module is already extracted and registered; this item only re-homes its test + rewires the one CI line + records the outcome.

## File Structure (all changes)

- Create (both profiles): `conf/<profile>/files/usr/share/node-red/osi-history-helper/index.test.js` (relocated from `scripts/test-history-helper.js`, import path re-pointed to `./index.js`) (T1–T2)
- Optionally create (both profiles): `osi-history-helper/__fixtures__/` (only if the existing suite reads external fixture files; inline the fixtures otherwise) (T1)
- Delete: `scripts/test-history-helper.js` (retired — its coverage now lives co-located) (T3)
- Modify: `.github/workflows/migrations.yml` (replace the `node scripts/test-history-helper.js` line with `node --test conf/…/osi-history-helper/index.test.js`) (T3)
- Modify: `docs/architecture/refactor-program-2026.md` (record 1.A3 outcome) (T4)

**Touches NO `flows.json`, NO `osi-lib`, NO `deploy.sh`, NO seed loop, NO schema/migration.**

---

### Task 1: Relocate the existing suite beside the module (bcm2712)

**Files:** Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js` from `scripts/test-history-helper.js`.

- [ ] **Step 1.1: Copy the existing suite to the co-located path** and re-point its module import. In `scripts/test-history-helper.js` the module is `require()`d via an absolute/repo-relative path to the bcm2712 module; in the co-located file it becomes `const helper = require('./index.js');` and `const { createAnalysis } = require('./analysis');` (the sibling files). Re-point any `database/seed-blank.sql` read to a repo-root-relative path that still resolves when the test is run via `node --test` from the repo root (e.g. resolve against `process.cwd()` or a computed repo-root, not against `__dirname` of the new location — the seed lives at repo `database/seed-blank.sql`, several levels up from the module dir). Verify the seed path resolves.
- [ ] **Step 1.2: Make it a pure `node:test` file (no self-exec).** If `scripts/test-history-helper.js` has a top-level runner/`process.exitCode` epilogue that assumes `node <file>` invocation, remove it so the file is a plain `node:test` suite runnable via `node --test` (the `test(...)` blocks self-register; `--test` drives them). Do NOT alter any assertion or vector — only the invocation scaffolding and the two `require` paths change. This is the ONE edit to the test text; it changes zero golden vectors.
- [ ] **Step 1.3: Preserve every assertion.** Diff the relocated file against the original to confirm ONLY the `require` paths + the self-exec scaffold changed; every `test(...)` block, every `assert`, every `kpaToPf`/SWT-pF/db-backed vector is byte-identical. (The behavior-preservation guarantee is that no vector was silently dropped or altered in the move.)
- [ ] **Step 1.4: Run the relocated suite — expect PASS:**
```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js
```
Green means the relocation preserved all coverage. If a case fails, it is an import-path/seed-path resolution problem introduced by the move — fix the path, NOT the vector.

---

### Task 2: Mirror to bcm2709 + parity

**Files:** Create `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.test.js` (+ any `__fixtures__/`) — the mirror imports its OWN sibling `./index.js` (byte-identical to bcm2712's), so a verbatim copy is correct.

- [ ] **Step 2.1: Copy the co-located test (and fixtures) verbatim; verify parity + run:**
```bash
cp -a conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.test.js
node scripts/verify-profile-parity.js
node --test conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.test.js
```

- [ ] **Step 2.2: Commit the co-located suite (both profiles):**
```bash
git add conf/*/files/usr/share/node-red/osi-history-helper/index.test.js
git commit -m "test(edge): co-locate osi-history-helper node --test beside the module (both profiles); vectors unchanged (refactor-program 1.A3)"
```

---

### Task 3: Retire the `scripts/` copy + rewire CI

**Files:** Delete `scripts/test-history-helper.js`; modify `.github/workflows/migrations.yml`.

- [ ] **Step 3.1: Rewire the CI line.** In `.github/workflows/migrations.yml`, REPLACE line 39 (`- run: node scripts/test-history-helper.js`) with:
```yaml
      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js
```
(The bcm2712 copy is the canonical run target, matching how other module tests are wired; profile parity guarantees the bcm2709 copy is byte-identical.)

- [ ] **Step 3.2: Delete the retired suite** (its coverage now lives co-located — keeping both would be the duplication this plan explicitly avoids):
```bash
git rm scripts/test-history-helper.js
```
Before deleting, `grep -rn "test-history-helper" .` to confirm NO other caller references it (only `migrations.yml:39`, which Step 3.1 rewires). If another reference exists (a `package.json` script, another workflow), report it and rewire that too.

- [ ] **Step 3.3: Verify wired + no dangling reference; commit:**
```bash
grep -rn "test-history-helper" . --include='*.yml' --include='*.json' --include='*.sh'   # expect: nothing (or only the new co-located path in migrations.yml if you name it so)
node -e "const y=require('fs').readFileSync('.github/workflows/migrations.yml','utf8'); if(!y.includes('osi-history-helper/index.test.js')||y.includes('scripts/test-history-helper.js')) throw new Error('not rewired'); console.log('rewired')"
git add .github/workflows/migrations.yml
git commit -m "ci: run co-located osi-history-helper node --test; retire scripts/test-history-helper.js (refactor-program 1.A3)"
```

---

### Task 4: Record 1.A3 outcome in the program doc, PR

- [ ] **Step 4.1:** In `docs/architecture/refactor-program-2026.md`, in the row for item 1.A3, append: `— done: osi-history-helper's node --test suite re-homed co-located (osi-history-helper/index.test.js), CI-wired via node --test, scripts/ copy retired; no module change, no vectors altered; DD4 "co-located node --test green in CI" leg proven against a live shipped module. PR #<FILL>`.
```bash
git add docs/architecture/refactor-program-2026.md
git commit -m "docs(program): record 1.A3 outcome (osi-history-helper test co-location — DD4 test-leg proof)"
```

- [ ] **Step 4.2: Full local CI-equivalent run (all green):** the co-located module test (both profiles via `--test`), `verify-profile-parity.js`, and a sanity `node scripts/verify-sync-flow.js` (unchanged — no node was touched). Confirm the suite that previously ran as `node scripts/test-history-helper.js` now runs identically green under `node --test` at the new path.

- [ ] **Step 4.3: Open the PR (do not merge)** — title `Co-locate node --test for osi-history-helper (refactor-program 1.A3)`; body: states plainly this is a test **relocation** (the module was already comprehensively tested by `scripts/test-history-helper.js`; the gap DD4 names is co-location), that ZERO vectors were altered and ZERO module code changed, that the only edits are the two `require` paths + self-exec scaffold + the CI line + retiring the old copy, and that it establishes the co-located `node --test` template 2.4/4.2 reuse. Note the 1.A1 charter dependency edge (and that this relocation has no hard code dependency on 1.A1 — it can land in either order, but the charter sequences it after).

---

## Follow-ups (not tasks in this plan)

- Any latent bug the relocated vectors would reveal (a `// KNOWN:` note) is a separate behavior-change PR, never folded into this relocation.
- Items **2.4** (Zone Env Summary) and **4.2** (History API Router) reuse this "co-located `node --test`, CI-wired via `node --test`" template against their newly-extracted modules; 4.2 in particular leans on this suite because `osi-history-helper` is its main callee and this co-located suite is what pins the callee's behavior while the router around it is extracted.
