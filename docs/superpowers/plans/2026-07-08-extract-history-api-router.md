# Extract History API Router — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes:** (1) work inside a feature branch `feat/extract-history-router` (worktree recommended); (2) the `flows.json` edit is made ONLY via a one-shot Node script per `.claude/skills/osi-flows-json-editing/SKILL.md` — roundtrip guard before AND after, both profiles in the same run, element-targeted edits re-compiled with `vm.Script`, NEVER blind regex; this is the LARGEST node in flows.json, so the false-positive risk from terse names is highest — the call-shaped lookbehind guard is mandatory; (3) every file under `conf/` changes in BOTH profiles (bcm2712 canonical, bcm2709 mirror) in the same commit; (4) run every command from the repo/worktree root; (5) CI green at every commit.
> **Spec:** [`docs/superpowers/specs/2026-07-08-extract-history-api-router-design.md`](../specs/2026-07-08-extract-history-api-router-design.md) (approved — this plan elaborates, it does not redesign). §A–§E references point there.
> **Charter:** `docs/architecture/refactor-program-2026.md` Phase 4, item 4.2 (the last, largest HTTP-shaped seam — "the HTTP-shaped monster"). **Depends on 1.A1 (osi-lib loader), 1.A2 (size ratchet), 1.A3 (osi-history-helper co-located test), AND the pattern proven TWICE by 2.2 (osi-dendro-analytics) and 2.4 (osi-zone-env).** DD4 orders this node LAST for exactly this reason. This plan assumes those dependencies are merged. If they are not, STOP: 4.2 cannot land before the pattern is twice-proven and its dependencies exist.

**Goal:** Extract the pure router-glue core of `flows.json` node `history-api-router-fn` (History API Router, 76,225 chars — the largest embedded-JS node) into a new tested `osi-history-router` module loaded via `osiLib.require`, leaving auth + DDL + SQL I/O + `osiHistory.*` delegation + HTTP orchestration in the residual node, with behavior pinned by golden vectors captured from the CURRENT node before the change, and the flows.json size scoreboard measurably decreased (the batch's biggest single drop). **A big-bang rewrite is FORBIDDEN** — the move is function-family-at-a-time, each pinned by a vector.

**Architecture:** New pure-Node module `conf/<profile>/files/usr/share/node-red/osi-history-router/` (`index.js` + `package.json` + co-located `index.test.js`), zero deps, exporting the §A pure glue functions. **DISTINCT from `osi-history-helper`** — 4.2 does NOT re-extract or duplicate the helper (the router keeps calling `osiHistory.*` for compute; this new module holds only the router's OWN param-parsing/validation/series-shaping glue). Registered in `osi-lib` `NAME_TO_PATH` (`'history-router'`) + all three delivery surfaces, gated by `verify-helper-registration.js`. The residual `history-api-router-fn` keeps its auth block, `ensureHistoryTables(run)` DDL block (HARD BOUNDARY — the 3 request-path CREATE-TABLE strings stay), all SQL read/write, all `osiHistory.*` delegation, the CSV export path, and route dispatch; it loads BOTH `osiHistory` (unchanged) and `osiLib.require('history-router')`, and uses the osi-lib §C **HTTP-shaped 503** load-failure path. Golden vectors are captured by executing the **pre-extraction** node body against a `node:sqlite` fixture DB with a fixed clock and the REAL (1.A3-tested) `osi-history-helper` via the `rehearse-devices-rebuild.js` facade-shim technique (spec §D), for a set of representative routes, then the post-extraction node is asserted to reproduce identical responses.

**Tech Stack:** Node.js only (`node --test`, `node:sqlite` — needs Node ≥22.5; CI runs Node 22). No new deps. CI: `.github/workflows/migrations.yml`.

## Global Constraints

- **Behavior-preserving extraction only; big-bang rewrite FORBIDDEN.** No parsing/validation/shaping change. A golden vector that reveals a latent bug is documented, not fixed here (separate later PR — program Risks).
- **4.2 does NOT re-extract `osi-history-helper`** (spec §ground-truth 1). No helper export is re-implemented in `osi-history-router`. Before moving any function, check it is NOT already an `osi-history-helper` export (`Object.keys(require('…/osi-history-helper/index.js'))`).
- **The `ensureHistoryTables(run)` DDL block is untouched — HARD BOUNDARY** (spec §ground-truth 3). Not moved, reordered, or altered. `verify-no-stray-ddl.js` (a must-not-increase ratchet on flows.json DDL markers — not a fixed count) enforces it. The 3 request-path CREATE-TABLE strings (`zone_seasons`, `history_card_preferences`, `history_workspaces`) are Stage-2 / item 4.3's concern, NOT this item's.
- **The `osiHistory.*` delegation + CSV export path stay in the adapter** — `verify-sync-flow.js:1231` requires `'osiHistory.buildZoneExportCsv'` to REMAIN in "History API Router".
- **The auth block stays in the adapter** — `verifyBearer`/JWT is impure.
- **`parseRangeSelection` moves with `nowMs` parameterized; the seven helper-bound dispatchers (`statusForCardValue`, `normalizeGatewayEui`, `uniqueDeveuis`, `displaySafeSourceKey`, `soilRowsHaveWarning`, `dendroRowsHaveWarning`, `environmentRowsHaveWarning`) and the wall-clock/state helpers (`nowIso`, `markPhase`, `addPhase`) STAY** (spec §B, HARD-DECISION #1).
- **HTTP-shaped 503 load-failure path** (osi-lib §C, spec §E) — `!r.ok` → `msg.statusCode = 503` + `module_unavailable`.
- **Both profiles byte-parity** for every changed `conf/` file (`verify-profile-parity.js`). Frozen `sync-init-fn` untouched.
- **No SSH, no live gateway, no production host.** All tests run locally/CI against fixtures.
- Branch `feat/extract-history-router`, commit per task, open a PR at the end, **do not merge it**.

## Verification findings (plan-write checks against `main` @ `f05b82ab`, 2026-07-08 — report, don't silently patch)

1. **Node confirmed:** `history-api-router-fn` / "History API Router", 76,225 chars, 1681-line `func`, 90 function declarations, libs `[osiDb, osiHistory(osi-history-helper), crypto]`, byte-identical in both profiles. It already calls `osiHistory.*` 31 times across 16 distinct methods — it is the helper's main callee. Wiring unchanged by extraction.
2. **The pure/impure split was full-body scanned** (spec §A/§ground-truth 2/§B) — every candidate's body was grepped, not just sampled. The clean movers are the §A "moves" list. **The scan surfaced functions that DON'T move, all pre-classified:**
   - **Helper-bound (call `osiHistory.*`) → STAY (7):** `statusForCardValue`, `normalizeGatewayEui`, `uniqueDeveuis`, `displaySafeSourceKey` (all `osiHistory.normalizeDeveui`), `soilRowsHaveWarning` (`classifySoilStatus`), `dendroRowsHaveWarning` (`classifyDendroStatus`), `environmentRowsHaveWarning` (`classifyEnvironmentStatus`). HARD-DECISION #1.
   - **Wall-clock / adapter-state → STAY:** `nowIso` (`new Date()`), `markPhase`/`addPhase` (`Date.now()` + mutate adapter-scope `const historyPhases`).
   - **Moves WITH `nowMs`:** `parseRangeSelection` (`toMs = Date.now()`) — the ONE clock reader in the move set.
   - `seasonBoundaryIso`'s `new Date(parsed)` parses the INPUT (deterministic) → pure, MOVES. `phaseSummary(phases)` (arg-driven) → MOVES.
   The plan re-greps EVERY mover's extracted body for `node.`/`osiDb`/`osiHistory`/`msg.`/`Date.now`/`new Date(` AND checks it against the helper's exports before moving it (Step 1.1).
3. **`ensureHistoryTables(run)` (node lines ~598–609) holds the DDL** — 3 `CREATE TABLE IF NOT EXISTS` (`zone_seasons`, `history_card_preferences`, `history_workspaces`), indexes, and a seed `INSERT`. It STAYS.
4. **`verify-sync-flow.js:1231`** has `expectIncludes('History API Router', 'osiHistory.buildZoneExportCsv', 'builds the zone CSV export via the helper')` (verified) — the CSV-export delegation must remain in the node.
5. **The async DB/helper functions do NOT move** (`getOwnedZoneContext`, `getGatewayContext`, `getActiveZoneSeason`, `getLatest*Rows`, the workspace/preference CRUD, `build*CardData`, `buildCardSummaries`, `buildAdvancedPayload`). Their pure sub-computations move and are called as `HR.<name>(...)`.
6. **`docs/contracts/history-router/` does not exist yet** — this plan creates it (Task 4).
7. **Delivery-surface locations confirmed** (same as 2.4): `deploy.sh` `fetch_required` blocks; `98_osi_node_red_seed:38` `for module in …` loop; runtime `package.json`/`package-lock.json`; `osi-lib/index.js` `NAME_TO_PATH`. `osi-lib` + `osi-history-router` are the two libs the node loads; the helper `osi-history-helper` is already registered (unchanged).
8. **Resolved at plan-write (no ambiguity left):** `markPhase`/`addPhase` close over adapter-scope `const historyPhases` + call `Date.now()` → STAY; `phaseSummary(phases)` is arg-driven → MOVES. Display helpers `displayDeviceName`/`displaySourceDevices`/`displaySourceLabels` verified clean (no `osiHistory`/`node.`/`crypto`) and non-duplicative of the helper's 38 exports → MOVE; `displaySafeSourceKey` calls `osiHistory.normalizeDeveui` → STAYS. The helper's exports were diffed against the move list — zero collisions.

## File Structure (all changes)

- Create (both profiles): `conf/<profile>/files/usr/share/node-red/osi-history-router/{index.js, package.json, index.test.js}` (T1)
- Modify (both profiles): `osi-lib/index.js` (`NAME_TO_PATH` += `'history-router'`), runtime `package.json` + `package-lock.json`, `98_osi_node_red_seed`; Modify `deploy.sh` (fetch pair) (T3)
- Create: `scripts/capture-history-router-vectors.js` (harness, not shipped to Pi) (T2)
- Create: `docs/contracts/history-router/{README.md, MANIFEST.json, cases/*.input.json, cases/*.expected.json}` (T4)
- Modify (both profiles): `conf/<profile>/files/usr/share/flows.json` — node `history-api-router-fn` only (T5)
- Modify: `.github/workflows/migrations.yml` (T6), `docs/architecture/refactor-program-2026.md` (T7)

---

### Task 1: `osi-history-router` module + per-function `node --test` (router-glue core, extracted verbatim)

**Files:** Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/{index.test.js, index.js, package.json}`; mirror to bcm2709 (Task 1.7).

**Interfaces:** `require('osi-history-router')` → the §A pure glue functions (`parseZoneId`, `parseRangeSelection` (with `nowMs`), `validateView`, `validateAggregation`, `boolValue`, `numberOrNull`, `parseJsonObject`, `seasonRangeForContext`, `seasonBoundaryIso`, `supportedRangesForCard`, `buildSeriesFromAggregate`, `truncateSeries`, `pointQuality`, `buildPreferenceMap`, `normalizeWorkspaceRow`, `sortIsoDesc`, `latestIso`, `safeFilenamePart`, `httpError`, `phaseSummary`, `displayDeviceName`, `displaySourceDevices`, `displaySourceLabels`, the source-classification predicates (`isSoilSource`/`isEnvironmentSource`/`isIrrigationSource`/`isDendroSource`), the series/calendar shapers, etc. — the full verified-context-free set). **NOT exported (STAY in adapter):** `nowIso`, `markPhase`, `addPhase`, `normalizeGatewayEui`, `uniqueDeveuis`, `displaySafeSourceKey`, `soilRowsHaveWarning`, `dendroRowsHaveWarning`, `environmentRowsHaveWarning`, `statusForCardValue` — see §B.

- [ ] **Step 1.1: Re-verify purity AND non-duplication of every mover, then extract verbatim.** For each §A name: (a) grep its extracted body for `node.`, `osiDb`, `osiHistory`, `msg.`, `await q(`, `_db`, `env.get`, `Date.now`, `new Date(` — a hit means it does NOT move (or is parameterized per §B); (b) check it is NOT in `Object.keys(require('…/osi-history-helper/index.js'))` — if it duplicates a helper export, it does NOT move (the router should call `osiHistory.<name>`, not a copy). Copy the passing declarations **byte-for-byte** into `osi-history-router/index.js` under `'use strict';`, then `module.exports = { ...all names... }`. **Do not edit any function body** except `parseRangeSelection` (Step 1.2).

- [ ] **Step 1.2: Move `parseRangeSelection` with `nowMs` parameterized — the ONE edited function** (spec §B). Its body does `toMs = Date.now();`. Extend its signature with an options arg carrying `nowMs` (`parseRangeSelection(query, config, scopeContext, opts = {})`, `const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();`, use `nowMs`). The adapter supplies `{ nowMs: Date.now() }`. This mirrors 2.2's `irrDecision` `nowMs` parameterization exactly; a golden vector pins a relative-range case with a fixed `nowMs`.

- [ ] **Step 1.3: The seven helper-bound dispatchers + the wall-clock/state helpers STAY in the adapter** (spec §B, HARD-DECISION #1) — do NOT copy into the module: `statusForCardValue`, `normalizeGatewayEui`, `uniqueDeveuis`, `displaySafeSourceKey`, `soilRowsHaveWarning`, `dendroRowsHaveWarning`, `environmentRowsHaveWarning` (all call `osiHistory.*` — keeping them out keeps the glue module free of any `osi-history-helper` dependency), plus `nowIso`, `markPhase`, `addPhase` (wall-clock / mutate adapter-scope `historyPhases`). Verify each is genuinely absent from the module's `module.exports`.

- [ ] **Step 1.4: Write co-located per-function `node --test` vectors** — `osi-history-router/index.test.js`, one `test(...)` per exported function, asserting representative `(inputs) → output` pairs derived from the node's real usage: `parseZoneId(query)`, `parseRangeSelection(query, config, scopeContext, { nowMs: FIXED })` (relative + absolute + season cases — the ONE clock-parameterized mover, vectored with a FIXED `nowMs` so it is deterministic), `seasonBoundaryIso(value, endOfDay)` (input-parse, deterministic), `validateAggregation(value)` (valid + invalid), `buildSeriesFromAggregate(aggregate, channelKey)`, `pointQuality(point)`, `buildPreferenceMap(rows)`, `normalizeWorkspaceRow(row)`, `phaseSummary(phases)`, `seasonRangeForContext(...)`, `supportedRangesForCard(cardType)`, the source predicates (`isSoilSource`/`isDendroSource`/…), `calendarRowsFromSeries(series)`, `safeFilenamePart(name)`, the display helpers. Capture expected outputs by running the just-extracted (verbatim) functions — their output IS the behavior contract.

- [ ] **Step 1.5: `package.json`:**
```json
{ "name": "osi-history-router", "version": "1.0.0", "private": true, "main": "index.js" }
```

- [ ] **Step 1.6: Run the suite — expect PASS:**
```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.test.js
```

- [ ] **Step 1.7: Mirror to bcm2709 + parity:**
```bash
cp -a conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-router
node scripts/verify-profile-parity.js
```

- [ ] **Step 1.8: Commit**
```bash
git add conf/*/files/usr/share/node-red/osi-history-router
git commit -m "feat(edge): osi-history-router pure glue module (param/validation/shaping core of History API Router) + node --test (refactor-program 4.2, spec §A/§B)"
```

---

### Task 2: Golden-vector capture harness (run the CURRENT node across representative routes, real helper, fixed clock)

**Files:** Create `scripts/capture-history-router-vectors.js` (harness only, not shipped to the Pi — lives in `scripts/`).

**Interface:** CLI: `node scripts/capture-history-router-vectors.js --capture` (reads the CURRENT node from flows.json, runs it against the seeded fixture DB for a set of routes with a pinned clock + the REAL helper, snapshots each response into `docs/contracts/history-router/cases/`) and `--verify` (runs the CURRENT-on-disk node against the same seed for the same routes and asserts equality with the committed snapshot — used post-extraction to prove the residual node still matches).

- [ ] **Step 2.1: Build the harness on the `rehearse-devices-rebuild.js` pattern** (spec §D, §ground-truth 6). Reuse its `makeFacadeShim(dbPath)` over `node:sqlite`'s `DatabaseSync`, exposing the `osiDb.Database`-compatible surface the node uses (`{ all, run, close }`). Seed the DB from `database/seed-blank.sql` plus fixture rows: a zone with soil/dendro/environment devices + `device_data`/`dendrometer_readings` history rows, a gateway + `gateway_locations`, a `history_workspaces` row, `history_card_preferences` rows, a `zone_seasons` row. Read the node's `func` via `JSON.parse(fs.readFileSync(FLOWS,'utf8')).find(n => n.id === 'history-api-router-fn').func`.

- [ ] **Step 2.2: Load the REAL helper + pin the clock (do NOT stub the helper).** Run the node body inside a `vm`/`Function` sandbox with the globals Node-RED provides: `node` (stub with `log`/`error`/`status`/`warn`), `osiDb` (facade), `osiHistory` = the real `require('…/osi-history-helper/index.js')` (deterministic + 1.A3-tested — NOT stubbed), `crypto` (real), a pinned clock (freeze `Date.now`/`new Date`), and `msg` per route pre-populated with a valid bearer (or stub `verifyBearer` to pass) + the route's path/query/method. For `--capture` the PRE-extraction node runs and does NOT use `osiLib`; for `--verify` the POST-extraction node runs and DOES, so its `osiLib` stub returns the real `osi-history-router`.

> Worker note: the `--capture` snapshot MUST be taken from the node as it exists BEFORE Task 5 edits it (the pre-extraction body). Capture in this task, commit the fixtures in Task 4, then Task 5 edits the node, then `--verify` proves the edited node reproduces the committed snapshot. Order matters — this is the behavior-preservation LAW.

- [ ] **Step 2.3: Snapshot the responses for ≥4 representative routes.** Drive at least: (a) a card-summary GET, (b) a series/aggregate GET, (c) a workspace CRUD op (create or update), (d) a CSV export. For each, capture the returned `msg` (payload OR streamed CSV bytes for the export), normalize (pin the fixed-clock timestamps), and write `docs/contracts/history-router/cases/<route>.expected.json` (+ raw CSV bytes for the export case); write the seed + route request as `<route>.input.json`. The CSV case pins that the `osiHistory.buildZoneExportCsv`/`respondCsv` path is byte-identical.

- [ ] **Step 2.4: Prove `--capture` and `--verify` agree on the CURRENT node** (before any extraction): run `--capture` then `--verify` back-to-back against the unedited node; `--verify` must pass (self-consistency of the harness). Commit the harness.
```bash
node scripts/capture-history-router-vectors.js --capture
node scripts/capture-history-router-vectors.js --verify   # green against the pre-extraction node
git add scripts/capture-history-router-vectors.js
git commit -m "feat(ci): history-router golden-vector capture/verify harness (node:sqlite facade + real helper + fixed clock, multi-route) (refactor-program 4.2, spec §D)"
```

---

### Task 3: Register `osi-history-router` in osi-lib NAME_TO_PATH + all three delivery surfaces

**Files:** Modify (both profiles) `osi-lib/index.js`, runtime `package.json` + `package-lock.json`, `98_osi_node_red_seed`; Modify `deploy.sh`.

- [ ] **Step 3.1: `osi-lib` NAME_TO_PATH.** In `conf/<profile>/files/usr/share/node-red/osi-lib/index.js`, add to `NAME_TO_PATH`: `'history-router': 'osi-history-router',` (a non-codec entry → `verify-helper-registration.js` enforces its three surfaces). Both profiles, byte-identical.

- [ ] **Step 3.2: Runtime `package.json` + `package-lock.json`** (scripted, roundtrip-guarded — reuse the `register-modules.js` pattern, `NEW_MODULES = ['osi-history-router']`): add `"osi-history-router": "file:osi-history-router"` to `dependencies`; add the three lock entries (root dep, `node_modules/osi-history-router` link, version entry).

- [ ] **Step 3.3: Seed loop.** In `98_osi_node_red_seed` (line 38 `for module in …`), add `osi-history-router` to the list (both profiles).

- [ ] **Step 3.4: `deploy.sh` fetch pair** (helper-fetch section, after another helper's block):
```bash
fetch_required "osi-history-router package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/package.json" \
    "/srv/node-red/osi-history-router/package.json"
fetch_required "osi-history-router index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.js" \
    "/srv/node-red/osi-history-router/index.js"
```

- [ ] **Step 3.5: Mirror bcm2712 → bcm2709 for every changed file; verify + commit:**
```bash
node scripts/verify-profile-parity.js
node scripts/verify-helper-registration.js   # osi-history-router now green across all three surfaces
git add -A conf deploy.sh
git commit -m "feat(edge): register osi-history-router in osi-lib NAME_TO_PATH + three delivery surfaces (refactor-program 4.2, spec §E)"
```

---

### Task 4: Formalize `docs/contracts/history-router/` (README + MANIFEST + cases)

**Files:** Create `docs/contracts/history-router/README.md`, `MANIFEST.json`, and confirm `cases/*.input.json` / `*.expected.json` from Task 2 are in place.

- [ ] **Step 4.1: README** (mirror the `docs/contracts/dendro/README.md` convention 2.2 established): state osi-os is the source of truth, that these fixtures are route-request+seed → expected-response captured from the pre-extraction node across ≥4 routes (incl. a CSV export), and that they are the behavior-preservation artifact (no cross-repo mirror defined by 4.2).

- [ ] **Step 4.2: `MANIFEST.json`** — an ordered list of case/route names + a `schemaVersion` integer.

- [ ] **Step 4.3: Commit** the contract fixtures:
```bash
git add docs/contracts/history-router
git commit -m "feat(contract): docs/contracts/history-router golden-vector fixtures captured from the pre-extraction node (refactor-program 4.2, spec §D)"
```

---

### Task 5: Flows migration — remove the router-glue core from the node, call the module

**Files:** Modify (via one-shot mutation script, both profiles) `conf/<profile>/files/usr/share/flows.json` — node `history-api-router-fn` ONLY. **No big-bang rewrite** — the script removes the moved declarations + rewrites their call sites; the residual node's control flow is otherwise untouched.

- [ ] **Step 5.1: Write the one-shot mutation script** (scratchpad, not repo; roundtrip guard before/after per the flows skill; element-targeted, re-compiled with `vm.Script` — NEVER blind regex; this is the LARGEST node, so the false-positive risk is highest). The script:
  - loads flows, roundtrip-guards, finds `history-api-router-fn`, asserts `node.name === 'History API Router'`.
  - **Removes** the §A "moves" function declarations from the node's `func` (they now live in the module). **Does NOT remove** the seven helper-bound dispatchers (`statusForCardValue`, `normalizeGatewayEui`, `uniqueDeveuis`, `displaySafeSourceKey`, `soilRowsHaveWarning`, `dendroRowsHaveWarning`, `environmentRowsHaveWarning`), the wall-clock/state helpers (`nowIso`, `markPhase`, `addPhase`), or any async/DDL/auth function — all stay (§B).
  - **Inserts** near the top of the async handler (after the DB open, before first use): `const _hrLoad = osiLib.require('history-router'); if (!_hrLoad.ok) { msg.statusCode = 503; msg.payload = { error: 'module_unavailable', module: 'history-router', message: _hrLoad.error }; node.error('History API Router: router module unavailable: ' + _hrLoad.error, msg); return [null, msg]; } const HR = _hrLoad.value;` (spec §E HTTP-shaped 503 path — match the node's actual output-array shape; verify the number of outputs).
  - **Rewrites moved-function call sites** so `parseZoneId(...)` → `HR.parseZoneId(...)`, `buildSeriesFromAggregate(...)` → `HR.buildSeriesFromAggregate(...)`, etc. — for every MOVED function, INCLUDING call sites inside the RETAINED async functions (`build*CardData` call the moved shapers; the retained helper-bound dispatchers may call moved shapers too). `parseRangeSelection(query, config, scopeContext)` → `HR.parseRangeSelection(query, config, scopeContext, { nowMs: Date.now() })` (the parameterized clock, §B). **Use word-boundary / call-shaped matching, not naive `String.replace`** — terse names (`boolValue`, `numberOrNull`, `latestIso`) and one-char-adjacent names WILL over-match. Match `(?<![\w$.])parseZoneId\s*\(` (call site, not member access, not identifier suffix) → `HR.parseZoneId(`; the `(?<![\w$.])` lookbehind is the false-positive guard the 1.A1 bare-require ratchet uses. **The STAYING functions' call sites are NOT rewritten** — the seven helper-bound dispatchers (`statusForCardValue`, `normalizeGatewayEui`, `uniqueDeveuis`, `displaySafeSourceKey`, `soilRowsHaveWarning`, `dendroRowsHaveWarning`, `environmentRowsHaveWarning`) and `nowIso`/`markPhase`/`addPhase` remain adapter-local, called bare.
  - adds `{"var":"osiLib","module":"osi-lib"}` to the node's `libs` (alongside `osiDb`/`osiHistory`/`crypto`).
  - **Post-conditions asserted by the script (fail = STOP):** (a) the node's `func` STILL contains all 3 request-path CREATE-TABLE strings AND `'osiHistory.buildZoneExportCsv'` (DDL + CSV delegation untouched — mirrors `verify-no-stray-ddl` + `verify-sync-flow.js:1231`); (b) no moved glue-function *declaration* remains (`function parseZoneId(` … absent for all moved names); (c) **no un-prefixed call to any moved function remains** — for each moved name, assert every call-shaped occurrence is `HR.`-prefixed (zero matches of `(?<![\w$.])(parseZoneId|buildSeriesFromAggregate|…)\s*\(` not immediately preceded by `HR.`); (d) the STAYING functions' declarations still present in the node (NOT moved): the seven helper-bound dispatchers (`statusForCardValue`, `normalizeGatewayEui`, `uniqueDeveuis`, `displaySafeSourceKey`, `soilRowsHaveWarning`, `dendroRowsHaveWarning`, `environmentRowsHaveWarning`) and `nowIso`/`markPhase`/`addPhase`; (e) the auth block (`verifyBearer`/`getAuthSecret`), `ensureHistoryTables`, and the async DB/CRUD functions still present; (f) `sync-init-fn` untouched; (g) zero bare non-builtin `require(` introduced; (h) `vm.Script(node.func)` compiles (syntax-valid).
  - writes both profiles, post-write roundtrip guard.

- [ ] **Step 5.2: Run the mutation; then run the ratchets:**
```bash
node /tmp/claude-*/…/scratchpad/migrate-history-router-node.js
node scripts/verify-flows-size-ratchet.js   # total DECREASED vs origin/main (biggest single drop); NOTE line ok
node scripts/verify-no-stray-ddl.js         # UNCHANGED / not increased (DDL stayed inline)
```

- [ ] **Step 5.3: Prove behavior preservation — the residual node reproduces the committed golden vectors across all routes:**
```bash
node scripts/capture-history-router-vectors.js --verify   # POST-extraction node == committed snapshot (all routes, incl. CSV)
```
If `--verify` fails, the extraction changed behavior — STOP, diff the failing route's fields, and fix the adapter wiring (do NOT edit the fixture; the fixture is the pre-extraction truth).

- [ ] **Step 5.4: Full flows pre-commit checklist:**
```bash
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js            # incl. the osiHistory.buildZoneExportCsv expectIncludes at line 1231
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
bash scripts/check-mqtt-topics.sh
```

- [ ] **Step 5.5: Commit**
```bash
git add conf/*/files/usr/share/flows.json
git commit -m "refactor(edge): extract History API Router glue core to osi-history-router; residual node = auth+DDL+SQL+helper-delegation+HTTP only (refactor-program 4.2, spec §A/§C; behavior pinned by multi-route golden vectors)"
```

---

### Task 6: CI wiring

**Files:** Modify `.github/workflows/migrations.yml`.

- [ ] **Step 6.1:** Add the module test as a discrete run line: `- run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.test.js`. Add a run line for the vector verify: `- run: node scripts/capture-history-router-vectors.js --verify` (runs against the committed post-extraction node + committed fixtures — the standing multi-route behavior-preservation regression gate).

- [ ] **Step 6.2: Verify + commit:**
```bash
node -e "const y=require('fs').readFileSync('.github/workflows/migrations.yml','utf8'); if(!y.includes('osi-history-router')||!y.includes('capture-history-router-vectors')) throw new Error('not wired'); console.log('wired')"
git add .github/workflows/migrations.yml
git commit -m "feat(ci): wire osi-history-router tests + multi-route golden-vector verify into Edge Migrations (refactor-program 4.2)"
```

---

### Task 7: Program-doc outcome + PR

- [ ] **Step 7.1:** In `docs/architecture/refactor-program-2026.md` Phase 4 table, append to the 4.2 row: `— done: osi-history-router extracted (glue core), multi-route golden-vectored (incl. CSV), scoreboard's biggest single drop, HTTP-shaped 503 load-fail path; helper untouched; no big-bang rewrite. PR #<FILL>`. (No DD4 re-scoping edit needed — 2.2 already recorded the I/O-heavy refinement.)
```bash
git add docs/architecture/refactor-program-2026.md
git commit -m "docs(program): record 4.2 outcome (History API Router extraction — terminal seam)"
```

- [ ] **Step 7.2: Full local CI-equivalent run** (all green): the module test, the multi-route vector `--verify`, `verify-helper-registration.js`, `verify-flows-size-ratchet.js` (total dropped — biggest single drop), `verify-no-stray-ddl.js` (not increased), `verify-profile-parity.js`, `verify-sync-flow.js` (incl. 1231), `test-flows-wiring.js`.

- [ ] **Step 7.3: Open the PR (do not merge)** — title `Extract History API Router → osi-history-router (refactor-program 4.2)`; body: summary of the glue-core extraction, the explicit "helper NOT re-extracted / no big-bang rewrite" statement, the DDL-stays (3 CREATE-TABLE)/auth-stays/CSV-delegation-stays boundary, the `parseRangeSelection` `nowMs` parameterization + `statusForCardValue`-stays decision, the HTTP-shaped 503 load-fail path, the multi-route golden-vector proof (`--verify` green incl. CSV), the scoreboard decrease (largest of the batch). Note dependencies 1.A1/1.A2/1.A3/2.2/2.4 must be merged first.

---

## Follow-ups (not tasks in this plan)

- The 3 request-path CREATE-TABLE strings in `ensureHistoryTables()` are Stage-2 / item 4.3's concern (boot-path DDL removal), never touched here.
- The seven helper-bound dispatchers (`statusForCardValue`, `normalizeGatewayEui`, `uniqueDeveuis`, `displaySafeSourceKey`, `soilRowsHaveWarning`, `dendroRowsHaveWarning`, `environmentRowsHaveWarning`) and the wall-clock/state helpers (`nowIso`, `markPhase`, `addPhase`) are deliberately left in the adapter (spec §B, HARD-DECISION #1); if a later item wants them under the contract, they move then.
- Any latent bug a golden vector reveals is a separate behavior-change PR (program Risks), never folded into this behavior-preserving extraction.
