# Extract Get Zone Environment Summary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes:** (1) work inside a feature branch `feat/extract-zone-env` (worktree recommended); (2) the `flows.json` edit is made ONLY via a one-shot Node script per `.claude/skills/osi-flows-json-editing/SKILL.md` — roundtrip guard before AND after, both profiles in the same run, element-targeted edits re-compiled with `vm.Script`, NEVER blind regex; (3) every file under `conf/` changes in BOTH profiles (bcm2712 canonical, bcm2709 mirror) in the same commit; (4) run every command from the repo/worktree root; (5) CI green at every commit.
> **Spec:** [`docs/superpowers/specs/2026-07-08-extract-zone-env-summary-design.md`](../specs/2026-07-08-extract-zone-env-summary-design.md) (approved — this plan elaborates, it does not redesign). §A–§E references point there.
> **Charter:** `docs/architecture/refactor-program-2026.md` Phase 2, item 2.4 (second HTTP-shaped seam). **Depends on 1.A1 (osi-lib loader), 1.A2 (size ratchet), and 2.2 (dendro extraction — pattern proof) being merged.** This plan assumes `osi-lib/`, `verify-helper-registration.js`, and `verify-flows-size-ratchet.js` exist on the base branch. If they do not, STOP: 2.4 cannot land before its dependencies.

**Goal:** Extract the pure compute/assembly core of `flows.json` node `zone-env-fn` (Get Zone Environment Summary, 67,317 chars) into a new tested `osi-zone-env` module loaded via `osiLib.require`, leaving auth + DDL + SQL I/O + HTTP orchestration in the residual node, with behavior pinned by golden vectors captured from the CURRENT node before the change, and the flows.json size scoreboard measurably decreased.

**Architecture:** New pure-Node module `conf/<profile>/files/usr/share/node-red/osi-zone-env/` (`index.js` + `package.json` + co-located `index.test.js`), zero deps, exporting the §A pure functions. Registered in `osi-lib` `NAME_TO_PATH` (`'zone-env'`) + all three delivery surfaces, gated by `verify-helper-registration.js`. The residual `zone-env-fn` keeps its auth block, `ensureSchema()` DDL block (HARD BOUNDARY — the 4 request-path CREATE-TABLE strings stay), all SQL read/write, and the weather-HTTP integration; it calls the module's functions via `osiLib.require('zone-env').value.*` and uses the osi-lib §C **HTTP-shaped 503** load-failure path (this is a live request handler, not a scheduler tick). Golden vectors are captured by executing the **pre-extraction** node body against a `node:sqlite` fixture DB with stubbed HTTP + a fixed clock via the `rehearse-devices-rebuild.js` facade-shim technique (spec §D), then the post-extraction node is asserted to reproduce the identical response bundle.

**Tech Stack:** Node.js only (`node --test`, `node:sqlite` — needs Node ≥22.5; CI runs Node 22). No new deps. CI: `.github/workflows/migrations.yml`.

## Global Constraints

- **Behavior-preserving extraction only.** No compute change. A golden vector that reveals a latent bug is documented, not fixed here (separate later PR — program Risks).
- **The `ensureSchema()` DDL block is untouched — HARD BOUNDARY** (spec §ground-truth 3). Not moved, reordered, or altered. TWO gates enforce it: `verify-sync-flow.js:1696` requires `'CREATE TABLE IF NOT EXISTS zone_weather_cache'` to REMAIN in "Get Zone Environment Summary"; `verify-no-stray-ddl.js` is a must-not-increase ratchet on flows.json DDL markers. The 4 request-path CREATE-TABLE strings (`zone_shared_environment`, `gateway_locations`, `zone_weather_cache`, `valve_actuation_expectations`) are Stage-2 / item 4.3's concern, NOT this item's.
- **The auth block and HTTP integration stay in the adapter** — `verifyBearer`/JWT and the OpenAgri/Open-Meteo/shared-bundle `fetch*` family are impure; only their pure sub-computations move.
- **New module is a separate directory** `osi-zone-env/`.
- **HTTP-shaped 503 load-failure path** (osi-lib §C, spec §E) — this node is on a live request path, so `!r.ok` → `msg.statusCode = 503` + `module_unavailable`, NOT a scheduler `return null`.
- **Both profiles byte-parity** for every changed `conf/` file (`verify-profile-parity.js`). Frozen `sync-init-fn` untouched.
- **No SSH, no live gateway, no production host.** All tests run locally/CI against fixtures.
- Branch `feat/extract-zone-env`, commit per task, open a PR at the end, **do not merge it**.

## Verification findings (plan-write checks against `main` @ `f05b82ab` (origin/main; working tip `6322a07a`), 2026-07-08 — report, don't silently patch)

1. **Node confirmed:** `zone-env-fn` / "Get Zone Environment Summary", 67,317 chars, 1425-line `func`, libs `[osiDb, crypto, httpLib(http), httpsLib(https)]`, byte-identical in both profiles. Its wiring feeds the HTTP-response chain (unchanged by extraction).
2. **The pure/impure split is verified with three known exceptions** (spec §A/§ground-truth 2/§B): most §A functions were sampled (`computeVPD`, `buildAgronomic`, `buildForecastSection`, `buildLocalEnvironment`, `resolveWaterAction`, `computeRecommendationDrift`) and reference no `node.*`, no DB, no `httpLib`/`httpsLib`, no `Date.now()`, no `env.get`. **A full scan found THREE movers that read `new Date()`** — `parseOpenAgriForecast` (unconditional `observedAt: new Date().toISOString()`), `mergeForecasts` (`|| new Date().toISOString()` fallback), `localDateIso` (`value ? new Date(value) : new Date()` fallback). These move only with the clock parameterized (§B, Step 1.2b) — they are the ONLY edited movers. The plan re-greps EVERY mover's extracted body for `new Date(`/`Date.now` before moving it (Step 1.1) — any additional hit means it does not move or is parameterized (§B).
3. **`ensureSchema()` (node lines ~1063–1085) holds the DDL** — 4 `CREATE TABLE IF NOT EXISTS`, ~10 `ALTER TABLE`, 2 `CREATE INDEX`. It STAYS. Confirmed `verify-sync-flow.js` has an `expectIncludes('Get Zone Environment Summary', 'CREATE TABLE IF NOT EXISTS zone_weather_cache', …)` at line 1696 and an `expectIncludes(…, "const lib = urlString.startsWith('https:') ? httpsLib : httpLib;", …)` at line 1699 — both must stay satisfied (the DDL and the HTTP-client usage remain in the node).
4. **The async provider/DB functions do NOT move** (`resolveOnlineCurrent`, `resolveForecast`, `safeResolve*`, `buildWaterEnvironment`, `buildWaterHistory`, `getCache`/`putCache`, `fetchOpenAgri*`, `fetchOpenMeteo*`, `fetchSharedBundle`, `getLinkedServerTarget`, `loadEstimatedIrrigationByLocalDate`). Their pure sub-computations move and are called as `ZE.<name>(...)`.
5. **`docs/contracts/zone-env/` does not exist yet** — this plan creates it (Task 4).
6. **Delivery-surface locations confirmed:** `deploy.sh` `fetch_required` blocks (existing `osi-history-helper` at lines ~581–589; note it has THREE fetch lines for index.js+analysis.js+package.json — `osi-zone-env` needs TWO: index.js + package.json); `98_osi_node_red_seed:38` `for module in …` loop; runtime `package.json`/`package-lock.json`; `osi-lib/index.js` `NAME_TO_PATH`. `osi-lib` itself is registered by 1.A1 (dependency).
7. **The `s` SQL-literal helper (node line ~85)** — verify at implementation whether it is a pure string helper (moves) or coupled to the query builder (stays). Default to STAY if ambiguous; it is trivially small and moving it risks nothing gained.

## File Structure (all changes)

- Create (both profiles): `conf/<profile>/files/usr/share/node-red/osi-zone-env/{index.js, package.json, index.test.js}` (T1)
- Modify (both profiles): `osi-lib/index.js` (`NAME_TO_PATH` += `'zone-env'`), runtime `package.json` + `package-lock.json`, `98_osi_node_red_seed`; Modify `deploy.sh` (fetch pair) (T3)
- Create: `scripts/capture-zone-env-vectors.js` (harness, not shipped to Pi) (T2)
- Create: `docs/contracts/zone-env/{README.md, MANIFEST.json, cases/*.input.json, cases/*.expected.json}` (T4)
- Modify (both profiles): `conf/<profile>/files/usr/share/flows.json` — node `zone-env-fn` only (T5)
- Modify: `.github/workflows/migrations.yml` (T6), `docs/architecture/refactor-program-2026.md` (T7)

---

### Task 1: `osi-zone-env` module + per-function `node --test` (compute/assembly core, extracted verbatim)

**Files:** Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/{index.test.js, index.js, package.json}`; mirror to bcm2709 (Task 1.6).

**Interfaces:** `require('osi-zone-env')` → `{ toFiniteNumber, round, mean, median, minValue, maxValue, computeVPD, computeDewPoint, computeHeatIndexC, computeTHI, maxInstant, safeJsonParse, toIsoTime, cacheStatus, extractFirstMetric, extractMetrics, aggregateMetric, buildLocalEnvironment, resolveLocation, normalizeCloudServerUrl, normalizeSchedulingMode, normalizeDisplayMode, absoluteDelta, isIrrigationActionConflict, buildDisplayStatus, computeRecommendationDrift, bundleAgeMinutes, normalizePrecipitationProbability, findMetric, deriveCropCoefficient, estimateStepHours, sumRain, buildForecastSection, buildAgronomic, addUtcDays, toEffectiveIrrigationMm, buildSensorHealth, resolveWaterAction, mergeDailyIrrigationSplit, overlayLocalWaterIrrigationSplit, trimToNull, normalizeTimezone }` (verbatim movers) **plus the three clock-parameterized movers `parseOpenAgriForecast(raw, { observedAtMs })`, `mergeForecasts(openAgri, openMeteo, { nowMs })`, `localDateIso(value, tz, nowMs)`** (§B — the ONLY edited movers), plus `s` only if verified pure per finding 7.

- [ ] **Step 1.1: Re-verify purity of every mover, then extract verbatim.** For each §A name, extract its declaration from `zone-env-fn`'s `func` and grep the body for `node.`, `osiDb`, `httpLib`, `httpsLib`, `await run(`, `await q(`, `env.get`, `Date.now`, `new Date(` — a hit means it does NOT move (or is parameterized per §B). THREE hits are already known (`parseOpenAgriForecast`, `mergeForecasts`, `localDateIso` — `new Date()`); handle them in Step 1.2b, not as verbatim copies. Report any ADDITIONAL hit. Copy the passing (clock-free) declarations **byte-for-byte** into `osi-zone-env/index.js` under `'use strict';`, then `module.exports = { ...all names... }`. **Do not edit any clock-free function body** — verbatim copy is the behavior-preservation guarantee.

- [ ] **Step 1.2b: Move the three clock-reading movers with the clock parameterized (spec §B — the ONLY edited functions).** In the module copies:
  - `parseOpenAgriForecast(raw)` → `parseOpenAgriForecast(raw, opts = {})`, read `const observedAtMs = opts.observedAtMs != null ? opts.observedAtMs : Date.now();`, replace `new Date().toISOString()` with `new Date(observedAtMs).toISOString()`.
  - `mergeForecasts(openAgri, openMeteo)` → `mergeForecasts(openAgri, openMeteo, opts = {})`, `const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();`, replace the fallback `new Date().toISOString()` with `new Date(nowMs).toISOString()`.
  - `localDateIso(value, tz)` → `localDateIso(value, tz, nowMs)`, replace `value ? new Date(value) : new Date()` with `value ? new Date(value) : new Date(nowMs != null ? nowMs : Date.now())`.
  - The adapter supplies `Date.now()` at every call site (rewritten in Task 5). Behavior-preserving: the adapter passes the same instant it would have stamped. Any ADDITIONAL clock-reading mover Step 1.1 surfaces gets the same treatment (add to `module.exports`, rewire its call sites in Task 5).

- [ ] **Step 1.3: Write co-located per-function `node --test` vectors** — `osi-zone-env/index.test.js`, one `test(...)` per exported function, asserting representative `(inputs) → output` pairs derived from the node's real usage: `computeVPD(tempC, rh)`, `computeTHI(tempC, rh)`, `computeDewPoint(tempC, rh)`, `deriveCropCoefficient(<inputs>)`, `buildAgronomic(<local+online+forecast>)`, `mergeForecasts(openAgri, openMeteo, { nowMs: FIXED })`, `parseOpenAgriForecast(<raw json>, { observedAtMs: FIXED })`, `localDateIso(<value>, tz, FIXED)`, `buildForecastSection(<merged>)`, `mergeDailyIrrigationSplit(<measured, estimated>)`, `overlayLocalWaterIrrigationSplit(<shared, local>)`, `computeRecommendationDrift(a, b)`, `resolveWaterAction(<inputs>)`, `buildSensorHealth(<inputs>)`, plus the numeric/normalizer helpers. **The three clock-parameterized movers MUST be vectored with a FIXED `observedAtMs`/`nowMs`** — otherwise their output embeds a fresh timestamp per call and the assertion is non-deterministic (this is precisely why §B parameterizes them). Capture expected outputs by running the just-extracted functions — their output IS the behavior contract. **For the agronomy-facing functions (`computeVPD`/`computeTHI`/`computeDewPoint`/`deriveCropCoefficient`/`buildAgronomic`), cross-reference the osi-agronomy-sensors-reference formulas when choosing inputs, and add a comment noting the vector freezes the CURRENT shipped formula (HARD-DECISION #1).**

- [ ] **Step 1.4: `package.json`:**
```json
{ "name": "osi-zone-env", "version": "1.0.0", "private": true, "main": "index.js" }
```

- [ ] **Step 1.5: Run the suite — expect PASS:**
```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js
```

- [ ] **Step 1.6: Mirror to bcm2709 + parity:**
```bash
cp -a conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-env
node scripts/verify-profile-parity.js
```

- [ ] **Step 1.7: Commit**
```bash
git add conf/*/files/usr/share/node-red/osi-zone-env
git commit -m "feat(edge): osi-zone-env pure module (compute/assembly core of Zone Env Summary) + node --test (refactor-program 2.4, spec §A/§B)"
```

---

### Task 2: Golden-vector capture harness (run the CURRENT node against a node:sqlite fixture DB with stubbed HTTP + fixed clock)

**Files:** Create `scripts/capture-zone-env-vectors.js` (harness only, not shipped to the Pi — lives in `scripts/`).

**Interface:** CLI: `node scripts/capture-zone-env-vectors.js --capture` (reads the CURRENT node from flows.json, runs it against the seeded fixture DB with stubbed weather HTTP + a pinned clock, snapshots the returned response bundle into `docs/contracts/zone-env/cases/`) and `--verify` (runs the CURRENT-on-disk node against the same seed and asserts equality with the committed snapshot — used post-extraction to prove the residual node still matches).

- [ ] **Step 2.1: Build the harness on the `rehearse-devices-rebuild.js` pattern** (spec §D, §ground-truth 6). Reuse its `makeFacadeShim(dbPath)` over `node:sqlite`'s `DatabaseSync`, exposing the `osiDb.Database`-compatible surface the node uses (`{ all, run, close }`). Seed the DB from `database/seed-blank.sql` plus fixture rows for 2–3 zones: one with local sensors + explicit lat/long, one relying on the `gateway_locations` fallback, one with measured flow + STREGA-estimated irrigation. Read the node's `func` via `JSON.parse(fs.readFileSync(FLOWS,'utf8')).find(n => n.id === 'zone-env-fn').func`.

- [ ] **Step 2.2: Stub the weather HTTP + auth deterministically.** Run the node body inside a `vm`/`Function` sandbox with the same globals Node-RED provides: `node` (stub with `log`/`error`/`status`/`warn`), `osiDb` (facade), `crypto` (real), `httpLib`/`httpsLib` (STUBS returning fixed OpenAgri/Open-Meteo payloads so no live call is made), `env` (stub returning fixed `OPENAGRI_*` config), a pinned clock (freeze `Date.now`/`new Date` to a fixed instant so `computed_at`/cache TTLs are deterministic), and `msg` pre-populated with a valid bearer (or stub `verifyBearer` to pass). For `--capture` the PRE-extraction node runs and does NOT use `osiLib`; for `--verify` the POST-extraction node runs and DOES, so its `osiLib` stub returns the real `osi-zone-env`.

> Worker note: the `--capture` snapshot MUST be taken from the node as it exists BEFORE Task 5 edits it (the pre-extraction body). Capture in this task, commit the fixtures in Task 4, then Task 5 edits the node, then `--verify` proves the edited node reproduces the committed snapshot. Order matters — this is the behavior-preservation LAW.

- [ ] **Step 2.3: Snapshot the response bundle.** After running the node against the seed, capture the returned `msg.payload` (the environment summary bundle: local environment, online current, forecast section, agronomic block, water summary), normalize (pin/drop the fixed-clock timestamps), and write it as `docs/contracts/zone-env/cases/<case>.expected.json`; write the seed rows + stubbed-provider payloads as `<case>.input.json`. (Task 4 formalizes the directory + README + MANIFEST.)

- [ ] **Step 2.4: Prove `--capture` and `--verify` agree on the CURRENT node** (before any extraction): run `--capture` then `--verify` back-to-back against the unedited node; `--verify` must pass (self-consistency of the harness). Commit the harness.
```bash
node scripts/capture-zone-env-vectors.js --capture
node scripts/capture-zone-env-vectors.js --verify   # green against the pre-extraction node
git add scripts/capture-zone-env-vectors.js
git commit -m "feat(ci): zone-env golden-vector capture/verify harness (node:sqlite facade + stubbed HTTP + fixed clock) (refactor-program 2.4, spec §D)"
```

---

### Task 3: Register `osi-zone-env` in osi-lib NAME_TO_PATH + all three delivery surfaces

**Files:** Modify (both profiles) `osi-lib/index.js`, runtime `package.json` + `package-lock.json`, `98_osi_node_red_seed`; Modify `deploy.sh`.

- [ ] **Step 3.1: `osi-lib` NAME_TO_PATH.** In `conf/<profile>/files/usr/share/node-red/osi-lib/index.js`, add to `NAME_TO_PATH`: `'zone-env': 'osi-zone-env',` (a non-codec entry → `verify-helper-registration.js` enforces its three surfaces). Both profiles, byte-identical.

- [ ] **Step 3.2: Runtime `package.json` + `package-lock.json`** (scripted, roundtrip-guarded — reuse the `register-modules.js` pattern from the 1.A1 plan, with `NEW_MODULES = ['osi-zone-env']`): add `"osi-zone-env": "file:osi-zone-env"` to `dependencies`; add the three lock entries (root dep, `node_modules/osi-zone-env` link, version entry).

- [ ] **Step 3.3: Seed loop.** In `98_osi_node_red_seed` (line 38 `for module in …`), add `osi-zone-env` to the list (both profiles).

- [ ] **Step 3.4: `deploy.sh` fetch pair** (helper-fetch section, after another helper's block):
```bash
fetch_required "osi-zone-env package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/package.json" \
    "/srv/node-red/osi-zone-env/package.json"
fetch_required "osi-zone-env index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js" \
    "/srv/node-red/osi-zone-env/index.js"
```

- [ ] **Step 3.5: Mirror bcm2712 → bcm2709 for every changed file; verify + commit:**
```bash
node scripts/verify-profile-parity.js
node scripts/verify-helper-registration.js   # osi-zone-env now green across all three surfaces
git add -A conf deploy.sh
git commit -m "feat(edge): register osi-zone-env in osi-lib NAME_TO_PATH + three delivery surfaces (refactor-program 2.4, spec §E)"
```

---

### Task 4: Formalize `docs/contracts/zone-env/` (README + MANIFEST + cases)

**Files:** Create `docs/contracts/zone-env/README.md`, `MANIFEST.json`, and confirm `cases/*.input.json` / `*.expected.json` from Task 2 are in place.

- [ ] **Step 4.1: README** (mirror the `docs/contracts/dendro/README.md` convention 2.2 established): state osi-os is the source of truth, that these fixtures are input-rows+stubbed-provider-payloads → expected-response-bundle captured from the pre-extraction node, and that they are the behavior-preservation artifact for this extraction (no cross-repo mirror defined by 2.4).

- [ ] **Step 4.2: `MANIFEST.json`** — an ordered list of case names + a `schemaVersion` integer.

- [ ] **Step 4.3: Commit** the contract fixtures:
```bash
git add docs/contracts/zone-env
git commit -m "feat(contract): docs/contracts/zone-env golden-vector fixtures captured from the pre-extraction node (refactor-program 2.4, spec §D)"
```

---

### Task 5: Flows migration — remove the compute/assembly core from the node, call the module

**Files:** Modify (via one-shot mutation script, both profiles) `conf/<profile>/files/usr/share/flows.json` — node `zone-env-fn` ONLY.

- [ ] **Step 5.1: Write the one-shot mutation script** (scratchpad, not repo; roundtrip guard before/after per the flows skill; element-targeted, re-compiled with `vm.Script` — NEVER blind regex). The script:
  - loads flows, roundtrip-guards, finds `zone-env-fn`, asserts `node.name === 'Get Zone Environment Summary'`.
  - **Removes** the §A pure function declarations from the node's `func` (they now live in the module).
  - **Inserts** near the top of the async handler (after the DB open, before first use): `const _zeLoad = osiLib.require('zone-env'); if (!_zeLoad.ok) { msg.statusCode = 503; msg.payload = { error: 'module_unavailable', module: 'zone-env', message: _zeLoad.error }; node.error('Zone Env Summary: assembly module unavailable: ' + _zeLoad.error, msg); return [null, msg]; } const ZE = _zeLoad.value;` (spec §E HTTP-shaped 503 path — this is a request handler; match the node's actual output-array shape, verify the number of outputs).
  - **Rewrites moved-function call sites** so `computeVPD(...)` → `ZE.computeVPD(...)`, `buildAgronomic(...)` → `ZE.buildAgronomic(...)`, etc. — for every moved function, INCLUDING call sites inside the RETAINED adapter functions (`resolveOnlineCurrent`/`resolveForecast`/`buildWaterEnvironment` call the moved pure helpers). **For the three clock-parameterized movers, supply the adapter's clock at each call site:** `mergeForecasts(a, b)` → `ZE.mergeForecasts(a, b, { nowMs: Date.now() })`, `parseOpenAgriForecast(raw)` → `ZE.parseOpenAgriForecast(raw, { observedAtMs: Date.now() })`, `localDateIso(value, tz)` → `ZE.localDateIso(value, tz, Date.now())` (the parameterized clock, §B/Step 1.2b). **Use word-boundary / call-shaped matching, not naive `String.replace`** — terse names (`round`, `mean`, `s`, `median`) will over-match (`Math.round`, member accesses, identifier suffixes). Match `(?<![\w$.])round\s*\(` (call site, not member access, not identifier suffix) and rewrite to `ZE.round(`; the `(?<![\w$.])` lookbehind is the false-positive guard the 1.A1 bare-require ratchet uses.
  - adds `{"var":"osiLib","module":"osi-lib"}` to the node's `libs` (alongside `osiDb`/`crypto`/`httpLib`/`httpsLib`).
  - **Post-conditions asserted by the script (fail = STOP):** (a) the node's `func` STILL contains `'CREATE TABLE IF NOT EXISTS zone_weather_cache'` AND all 4 request-path CREATE-TABLE strings AND the `const lib = urlString.startsWith('https:') ? httpsLib : httpLib;` line (DDL + HTTP-client untouched — mirrors `verify-sync-flow.js:1696/1699`); (b) no moved pure-function *declaration* remains (`function computeVPD(` … absent for all moved names); (c) **no un-prefixed call to any moved function remains** — for each moved name, assert every call-shaped occurrence is `ZE.`-prefixed (zero matches of `(?<![\w$.])(computeVPD|buildAgronomic|mergeForecasts|…)\s*\(` not immediately preceded by `ZE.`); (d) the auth block (`verifyBearer`/`getAuthSecret`) and the `fetch*`/`resolve*` async functions still present (NOT moved); (e) `sync-init-fn` untouched; (f) zero bare non-builtin `require(` introduced; (g) `vm.Script(node.func)` compiles (syntax-valid).
  - writes both profiles, post-write roundtrip guard.

- [ ] **Step 5.2: Run the mutation; then run the ratchets:**
```bash
node /tmp/claude-*/…/scratchpad/migrate-zone-env-node.js
node scripts/verify-flows-size-ratchet.js   # total DECREASED vs origin/main (the DD4 win); NOTE line ok
node scripts/verify-no-stray-ddl.js         # UNCHANGED / not increased (DDL stayed inline)
```

- [ ] **Step 5.3: Prove behavior preservation — the residual node reproduces the committed golden vectors:**
```bash
node scripts/capture-zone-env-vectors.js --verify   # POST-extraction node == committed snapshot
```
If `--verify` fails, the extraction changed behavior — STOP, diff the failing case's fields, and fix the adapter wiring (do NOT edit the fixture; the fixture is the pre-extraction truth).

- [ ] **Step 5.4: Full flows pre-commit checklist:**
```bash
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js            # incl. the zone_weather_cache (1696) + httpLib (1699) expectIncludes
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
bash scripts/check-mqtt-topics.sh
```

- [ ] **Step 5.5: Commit**
```bash
git add conf/*/files/usr/share/flows.json
git commit -m "refactor(edge): extract Zone Env compute/assembly core to osi-zone-env; residual node = auth+DDL+SQL+HTTP only (refactor-program 2.4, spec §A/§C; behavior pinned by golden vectors)"
```

---

### Task 6: CI wiring

**Files:** Modify `.github/workflows/migrations.yml`.

- [ ] **Step 6.1:** Add the module test as a discrete run line (matching the existing `node --test` lines): `- run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js`. Add a run line for the vector verify: `- run: node scripts/capture-zone-env-vectors.js --verify` (runs against the committed post-extraction node + committed fixtures — the standing behavior-preservation regression gate).

- [ ] **Step 6.2: Verify + commit:**
```bash
node -e "const y=require('fs').readFileSync('.github/workflows/migrations.yml','utf8'); if(!y.includes('osi-zone-env')||!y.includes('capture-zone-env-vectors')) throw new Error('not wired'); console.log('wired')"
git add .github/workflows/migrations.yml
git commit -m "feat(ci): wire osi-zone-env tests + golden-vector verify into Edge Migrations (refactor-program 2.4)"
```

---

### Task 7: Program-doc outcome + PR

- [ ] **Step 7.1:** In `docs/architecture/refactor-program-2026.md` Phase 2 table, append to the 2.4 row: `— done: osi-zone-env extracted (compute/assembly core), golden-vectored, scoreboard decreased, HTTP-shaped 503 load-fail path, PR #<FILL>`. (No DD4 re-scoping edit needed — 2.2 already recorded the I/O-heavy refinement; 2.4 inherits it.)
```bash
git add docs/architecture/refactor-program-2026.md
git commit -m "docs(program): record 2.4 outcome (Zone Env Summary extraction)"
```

- [ ] **Step 7.2: Full local CI-equivalent run** (all green): the module test, the vector `--verify`, `verify-helper-registration.js`, `verify-flows-size-ratchet.js` (total dropped), `verify-no-stray-ddl.js` (not increased), `verify-profile-parity.js`, `verify-sync-flow.js` (incl. 1696/1699), `test-flows-wiring.js`.

- [ ] **Step 7.3: Open the PR (do not merge)** — title `Extract Get Zone Environment Summary → osi-zone-env (refactor-program 2.4)`; body: summary of the compute/assembly-core extraction, the DDL-stays (4 CREATE-TABLE, `zone_weather_cache` gated)/auth-stays/HTTP-stays boundary, the HTTP-shaped 503 load-fail path, the golden-vector proof (`--verify` green), the scoreboard decrease. Note dependencies 1.A1/1.A2/2.2 must be merged first.

---

## Follow-ups (not tasks in this plan)

- The 4 request-path CREATE-TABLE strings in `ensureSchema()` are Stage-2 / item 4.3's concern (boot-path DDL removal), never touched here.
- Item **4.2** (History API Router) reuses this HTTP-request-path extraction pattern for the last big seam.
- Any latent bug a golden vector reveals (esp. an agronomy formula) is a separate behavior-change PR (program Risks), never folded into this behavior-preserving extraction.
