# Extract Daily Dendrometer Analytics → Pure Module + Thin Adapter

**Status:** Draft
**Refactor-program item:** 2.2 (DD4 — first strangler seam; "done" definition proof #1)
**Focus: osi-os**
**Depends on:** 1.A1 (`osi-lib` loader — the mandated load mechanism defined in `2026-07-07-osi-lib-loader-design.md` §A/§B, with §E "Scope boundary" being the clause that requires every new seam to load this way) and 1.A2 (size ratchet — the merge gate that proves the extraction lowered the scoreboard).
**Feeds:** 2.3 (dendro cross-repo golden-vector contract consumes this module's fixtures) and 2.4 (Zone Env Summary reuses this pattern).

## Problem

`Daily Dendrometer Analytics` (`flows.json` node id `dendro-compute-fn`, both profiles byte-identical) is a **57,047-char** function node — the 4th-largest embedded-JS node in flows.json (measured 2026-07-08, `main` @ `612987d9`). It is the daily batch that turns raw dendrometer readings into per-tree stress metrics (TWD, MDS, envelope reference) and per-zone irrigation recommendations. DD4 names it the **first** strangler seam because the harness is cheapest here and blast radius smallest: it runs once daily on a scheduler tick, not on a live request path.

The node is not a clean pure-compute function today, and the pre-ruling's "pure compute (input rows → metrics)" framing is **half right** — corrected in Verified ground truth below. The node interleaves four concerns in one body:
1. ~90 idempotent DDL statements (6 `CREATE TABLE`, 79 `ALTER TABLE` in `MIGS` + 1 in a nearby comment = 80 counted, 3 `CREATE INDEX`, 1 `CREATE TRIGGER`, 1 `DROP TRIGGER` — the node contributes 91 markers total to `verify-no-stray-ddl`'s 351/profile flows.json total; the comment stays inline too, so the count is preserved) run at the top (`MIGS` array), ~8 KB of text.
2. SQLite reads (`SELECT` over `device_data`, `dendrometer_readings`, `irrigation_zones`, `devices`, state tables).
3. **Pure compute** — ~20 math/stats/classification functions (envelope, TWD, MDS, R², MAD outlier rejection, stress aggregation, irrigation decision).
4. SQLite writes (`INSERT`/`UPSERT` into `dendrometer_daily`, `zone_daily_recommendations`, `zone_irrigation_state`) **and** outbound HTTP calls to a weather/forecast API (`requestJson` → `/api/v1/auth/token`, `/api/v1/history/hourly/`).

DD4's "done" bar (cite, don't re-derive): **pure module + co-located `node --test` green in CI + adapter <~2 KB + golden vectors captured before extraction + loads via `osi-lib`.** The <~2 KB adapter bar is **not achievable for this node** as literally stated, and this spec says so honestly (§C) — the DDL, SQL I/O, and HTTP orchestration are irreducibly ~large and cannot move into a pure module. What IS achievable and what this item delivers: extract the **pure compute core** (concern 3) into a tested `osi-dendro-analytics` module loaded via `osi-lib`, shrinking the node's embedded JS by the compute-core's mass and lowering the 1.A2 scoreboard, with the compute behavior pinned by golden vectors captured from the current node before the change.

## Verified ground truth (corrections to the pre-ruling)

Measured/read directly from `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` node `dendro-compute-fn` (957 lines, 57,047 chars) on `main` @ `612987d9`, 2026-07-08:

1. **The node is NOT pure compute end-to-end — it is DB-I/O-and-HTTP-wrapped compute.** It opens the DB directly (`const _db = new osiDb.Database('/data/db/farming.db')`), runs the `MIGS` DDL block, queries, computes, and writes back — plus makes outbound HTTP to a weather API. The pre-ruling's "input rows → metrics" describes only concern 3. **The module boundary this spec draws is: pure compute functions move out; DDL + SQL + HTTP + the `node.*`/DB orchestration stay in the adapter.**
2. **`osi-dendro-helper` is a DIFFERENT, unrelated module** (`conf/.../node-red/osi-dendro-helper/index.js`, 10,881 bytes). It is the **per-uplink LSN50/ratio decoder** (`decodeRawAdcPayload`, `buildDendroDerivedMetrics`, `computeDendroDeltaMm`, `computeDendroStemChangeUm`, `calculateDendroRatio`) — it turns a single raw ADC payload into a position/delta at ingest time. The Daily Analytics node is the **daily aggregate** over already-decoded readings. They share the word "dendro" and nothing else: different inputs (raw base64 payload vs a day of position rows), different cadence (per-uplink vs daily), zero function overlap. **The new module MUST be a separate directory `osi-dendro-analytics/`, NOT merged into `osi-dendro-helper`.** Confirmed: none of the Daily Analytics compute functions exist in `osi-dendro-helper`.
3. **The `MIGS` DDL block is load-bearing and stays in the adapter.** Its ~90 statements (91 markers) are counted in the `verify-no-stray-ddl` baseline (part of flows.json's 351 markers/profile) and some overlap schema territory that `sync-init-fn` (frozen) also touches. A pure compute module cannot own DDL. The DDL is **not** golden-vectored (it is idempotent schema setup, not compute) and **not** moved. Behavior-preservation for the DDL is "it is byte-identical, untouched" — the extraction must not alter, reorder, or relocate a single `MIGS` entry.
4. **Not every "compute" function is context-free.** `irrDecision` calls `node.log(...)`, reads the module-level `COMPUTED_AT` constant, and calls `Date.now()` — it is NOT purely `(inputs) → output`. The genuinely-pure functions (no `node.*`, no DB, no HTTP, no outer-scope mutation, no wall-clock) are the extraction target; the impure ones are handled per §B's rule (parameterize the impurity or leave the function in the adapter). This is the single most important correctness decision in the item and is resolved explicitly in §B, not hand-waved.
5. **The precedent for "run the actual shipped function text" is `scripts/rehearse-devices-rebuild.js`** (cited by the pre-ruling, verified): it reads a node's `func` from flows.json (`JSON.parse(...).find(n => n.id === 'sync-init-fn').func`) and executes it against a real `node:sqlite` DB via a facade shim (`makeFacadeShim`) that mirrors the `osi-db-helper` API. §D reuses exactly this technique to capture golden vectors by executing the CURRENT `dendro-compute-fn` body against fixture DB rows — the outputs of that run ARE the golden vectors, so the module is proven behavior-identical to what ships today, not to a re-derivation.
6. **`node --test` + `node:sqlite` requires Node ≥22.5** (per migrations.yml's comment on line 32); CI already runs Node 22. The golden-vector capture harness (§D) uses `node:sqlite`'s `DatabaseSync` exactly as `rehearse-devices-rebuild.js` does.
7. **The node's libs today are `[{"var":"osiDb","module":"osi-db-helper"}]`** and its only wire is to a debug node (`dendro-compute-debug`). Extraction adds `{"var":"osiLib","module":"osi-lib"}` alongside `osiDb`; wiring is unchanged.

## Design

### A. Module boundary — what moves, what stays

**New module `conf/<profile>/files/usr/share/node-red/osi-dendro-analytics/` (`index.js` + `package.json`)** — pure Node, zero deps, registered in all three delivery surfaces per the osi-lib spec §E and gated by `verify-helper-registration.js` (added by 1.A1). Registered in `osi-lib`'s `NAME_TO_PATH` as `'dendro-analytics': 'osi-dendro-analytics'`.

**Moves into the module (pure compute core):** the context-free math/stats/classification functions —
`round`, `avg`, `percentile`, `median3`, `detectJumps`, `removeJumps`, `extractExtremes`, `computeVPD`, `buildQaFlags`, `computeEnvelope`, `classifyAbsoluteTwd`, `carryForwardState`, `computeAbsoluteDeltaTwdSmoothed`, `computeRDelta5day`, `adjustStress`, `computeR2`, `aggregateZoneStress`, `dendroThresholdStressLevel`, `decisionEscalationStress`, `applyDendroSchedulePolicy`, and the module-level constants they close over (`RANK`, `PHENO_MOD`, `LEVELS`, `MIN_SAMPLES_DAY`, `MIN_SAMPLES_WINDOW`, `LOW_SIGNAL_THRESHOLD_UM`, `JUMP_THRESHOLD_UM`, `N_TREES_FOR_EMERGENCY`, `DAYS_FOR_SOLO_EMERGENCY`, `CALIBRATIONS`). Plus the pure time/timezone helpers (`localHour`, `localTimeStr`, `localDateParts`, `shiftDateIso`, `tzOffsetMinutes`, `localMidnightUtcIso`, `computeZoneDayWindow`, `calibrationForKey`) — they are `Intl`-based and wall-clock-free (they take an explicit timestamp argument), so they are pure and belong in the module.

**Stays in the adapter (impure orchestration):** the DB open/query/run/close, the entire `MIGS` DDL block (§ground-truth 3), the SQL literal builders (`n`, `s`), `requestJson` + the weather-API helpers (`trimToNull`, `normalizeBaseUrl`, `buildFormBody`) and their HTTP calls, all `SELECT`/`INSERT`/`UPSERT` orchestration, `node.status`/`node.log`/`node.error`, and the `COMPUTED_AT`/`NOW` wall-clock capture. The adapter reads rows, calls the module's pure functions, and writes results back — the classic thin-adapter-over-pure-core shape.

### B. Handling the not-quite-pure functions — the load-bearing decision

`irrDecision` is the one function that mixes compute with impurity: it calls `node.log('Zone: rain suppression exited — TWD responded')`, reads `COMPUTED_AT`, calls `Date.now()`, and **mutates its `zs` argument** (zone state). Rule, applied per-function during implementation and pinned by the plan:

- **`irrDecision` moves into the module with its impurities parameterized, not smuggled.** Its signature gains explicit inputs for the two ambient values it reads (`computedAt` replacing the `COMPUTED_AT` constant; `nowMs` replacing `Date.now()`), and its one side effect (`node.log`) becomes an **optional `log` callback parameter** (`opts.log`, defaulting to a no-op) so the pure module has no `node` reference. The `zs`-mutation stays (the adapter passes a mutable zone-state object and reads it back after — behavior-identical), but is documented as an in/out parameter. This is behavior-preserving: the adapter supplies `computedAt = COMPUTED_AT`, `nowMs = Date.now()`, and `log = (m) => node.log(m)`, reproducing today's exact effect.
- **Rationale over the alternative (leave `irrDecision` in the adapter):** `irrDecision` is the irrigation-decision heart — the highest-value function to have under golden-vector test, and the one 2.3's cross-repo contract most wants pinned. Parameterizing three ambient inputs is a mechanical, behavior-preserving change; leaving it in the adapter would exclude the decision logic from the tested core for a cosmetic purity gain. The parameterization is itself covered by golden vectors (§D): a captured vector that exercised the rain-suppression-exit `node.log` branch will assert the `log` callback fired with the same message.
- **Any function whose impurity CANNOT be cleanly parameterized stays in the adapter** — none identified beyond `irrDecision`, but the rule is stated so the worker does not force a genuinely-impure function into the pure module. `aggregateZoneStress`, `computeEnvelope`, etc. are already fully pure (verified: no `node.`/DB/HTTP references in their bodies).

### C. The adapter size reality — honest against DD4's "<~2 KB" bar

DD4's "done" definition says "adapter <~2 KB." **This node cannot hit that**, and pretending otherwise would be dishonest. The DDL block alone is ~8 KB; the SQL read/write orchestration and HTTP weather integration are irreducibly several KB more. What the extraction achieves and commits to:

- **The pure compute core (~the functions in §A) leaves the node**, moving into `osi-dendro-analytics/index.js`. The node's remaining `func` is DDL + SQL I/O + HTTP + `osiLib.require('dendro-analytics')` + calls into the module. The **1.A2 total-JS scoreboard drops** by the compute core's char mass (the module's code does not count toward flows.json's embedded JS — it lives in a helper file), which is the measurable DD4 win.
- **This spec re-scopes the "adapter <~2 KB" bar to "the extracted pure core is a standalone tested module; the residual node is DDL+I/O+orchestration only, with zero compute logic left inline."** The correct DD4 read for an I/O-heavy node is "no business/compute logic remains embedded," not a literal 2 KB — a valve-routing node hits 2 KB, a daily-batch-with-90-migrations node does not. This re-scoping is recorded as a **DD4 refinement** in §Open decisions and should be echoed in the program doc when 2.2 lands (the "done" definition needs the nuance for the two remaining seams, 2.4 and 4.2, which are also I/O-heavy — see 2.4's ~66 KB and 4.2's ~74.5 KB, both HTTP-shaped).
- The residual node still loads via `osiLib.require` (DD2/DD4 satisfied), still gets its compute-core proven by golden vectors (behavior-preservation satisfied), still lowers the scoreboard (DD3 satisfied). The one bar it cannot meet literally is the byte count, and the reason is structural, not a shortcut.

### D. Golden vectors — captured from the CURRENT node before extraction (behavior-preservation LAW)

Per the program's behavior-preservation mandate and the pre-ruling: golden vectors are captured by executing the **CURRENT** `dendro-compute-fn` body against fixture DB rows, using the `rehearse-devices-rebuild.js` technique (§ground-truth 5). The captured input/output pairs are the contract the extracted module must reproduce exactly.

**Two vector layers, both captured before the extraction touches the node:**

1. **Unit vectors for the pure functions (the module's own `node --test`).** For each function in §A, capture representative `(inputs) → output` pairs by instrumenting the current node body. Because the pure functions are self-contained, these are captured by extracting the current function source and running it against hand-built and real-data-derived inputs (e.g. `computeEnvelope` over a captured sequence of `{dMax, dMin}` points; `aggregateZoneStress` over a captured array of tree metrics; `computeR2` over captured x/y arrays; `irrDecision` over captured `(hist3, rain, zs, nonRef)` tuples including one that trips the rain-suppression-exit `log` branch). These become `osi-dendro-analytics/index.test.js` assertions — the module reproduces each output byte-for-byte.
2. **End-to-end golden vectors (the extraction proof).** A capture harness (`scripts/capture-dendro-analytics-vectors.js`, kept in `scripts/`, not shipped to the Pi) seeds a `node:sqlite` DB from `database/seed-blank.sql` plus fixture rows representing 2–3 zones with a mix of trees (healthy, stressed, reference, low-confidence, missing-data), executes the **current** node `func` against it via the `makeFacadeShim` facade (mirroring `rehearse-devices-rebuild.js`), and snapshots the resulting `dendrometer_daily` / `zone_daily_recommendations` / `zone_irrigation_state` rows into `docs/contracts/dendro/` fixtures (the same directory 2.3 consumes — see that spec). Then the **extracted** node is run against the identical seed and its output rows are asserted equal to the snapshot. HTTP weather calls are stubbed deterministically in the harness (the weather integration is adapter-side and out of the compute contract; the stub returns fixed VPD inputs so the compute is deterministic). This proves the whole node, post-extraction, produces identical DB writes — the strongest behavior-preservation evidence available without a live gateway.

**Fixture location:** the per-function unit vectors live beside the module (`osi-dendro-analytics/index.test.js` / a `fixtures/` subdir); the end-to-end input-rows→expected-output-rows fixtures live in `docs/contracts/dendro/` because 2.3 mirrors exactly those into osi-server's test suite (the dendro cross-repo contract). This spec CREATES the `docs/contracts/dendro/` directory and its first fixtures; 2.3 defines the cross-repo parity gate over them.

### E. Load mechanism (cite osi-lib spec §A/§B mechanism + §E rule, do not re-derive)

The module loads via `osiLib.require('dendro-analytics')` per `2026-07-07-osi-lib-loader-design.md` §A/§B (the `osiLib.require` mechanism + `NAME_TO_PATH`) under §E's rule that every new seam MUST load this way: registered in `osi-lib`'s `NAME_TO_PATH`, packaged through the three delivery surfaces (runtime `package.json` + `package-lock.json`, `98_osi_node_red_seed` module loop, `deploy.sh` fetch pair), gated by `verify-helper-registration.js`. The adapter's load-failure path follows osi-lib §C's non-HTTP rule: on `!r.ok`, `node.error('Daily Dendro Analytics: analytics module unavailable: ' + r.error, msg)` + `node.status({fill:'red',...})` + `return null` (the node's existing early-return-on-failure idiom for migration failures, reused). `osiLib` is added to the node's `libs` alongside the existing `osiDb`. `osi-dendro-analytics` becomes a new non-codec `NAME_TO_PATH` entry, so `verify-helper-registration.js` enforces its three-surface registration at merge time.

## Non-goals

- **Changing any compute behavior.** Behavior-preserving extraction only; a captured golden vector that reveals a latent bug is documented, not fixed here (fix is a separate later PR per the program's Risks section).
- **Touching the `MIGS` DDL block** (§ground-truth 3) — not moved, not reordered, not altered; the `verify-no-stray-ddl` count for flows.json must be unchanged (the DDL stays in the node).
- **Merging into or modifying `osi-dendro-helper`** (§ground-truth 2) — separate module, untouched.
- **The weather/forecast HTTP integration** — stays adapter-side, stubbed in the vector harness; not part of the compute contract.
- **The osi-server side of the dendro contract** — that is item 2.3. This item only creates the osi-os module + the first `docs/contracts/dendro/` fixtures.
- **Deploying to any gateway.** No SSH, no live system.
- **Hitting a literal 2 KB adapter** (§C) — structurally impossible for this node; re-scoped to "zero compute logic remains inline."

## Definition of Done

- `osi-dendro-analytics/` module (`index.js` pure, zero deps, + `package.json`) in **both** profiles, byte-identical, exporting the §A pure functions; registered in all three delivery surfaces + `osi-lib` `NAME_TO_PATH` (`'dendro-analytics'`), green under `verify-helper-registration.js`.
- The §A functions are **removed from** `dendro-compute-fn`'s inline body; the node calls them via `osiLib.require('dendro-analytics').value.*`; `osiLib` added to the node's `libs`; the `MIGS` DDL block and all SQL/HTTP orchestration unchanged.
- `irrDecision` moved with its ambient inputs parameterized (`computedAt`, `nowMs`, `opts.log`) per §B; the adapter supplies today's exact values, proven behavior-identical by a golden vector exercising the `log` branch.
- `osi-dendro-analytics/index.test.js` (`node --test`): per-function unit vectors (§D-1) for every exported function, green in CI.
- `docs/contracts/dendro/` created with end-to-end input-rows → expected-output-rows fixtures (§D-2); `scripts/capture-dendro-analytics-vectors.js` captures them from the pre-extraction node and an assertion proves the post-extraction node reproduces them exactly (both via the `node:sqlite` + facade-shim harness).
- Both profiles byte-parity for every changed file (`verify-profile-parity.js` green); `verify-no-stray-ddl.js` unchanged (DDL untouched); `verify-flows-size-ratchet.js` (1.A2) shows the flows.json total **decreased**; `verify-sync-flow.js` green.
- Frozen `sync-init-fn` untouched.
- CI-wired: the module test + the end-to-end capture/replay assertion run in `migrations.yml`.

## Open decisions

None outstanding.

- **Module target: new `osi-dendro-analytics/`, NOT `osi-dendro-helper`** — §ground-truth 2; the two are unrelated (daily aggregate vs per-uplink decoder), zero function overlap.
- **`irrDecision`: move with parameterized impurity, not leave in the adapter** — §B; it is the irrigation-decision heart and the function 2.3's contract most wants pinned; the parameterization is mechanical and behavior-preserving.
- **DDL block stays in the adapter, untouched** — §ground-truth 3, §C; a pure module cannot own DDL, and it is in the `verify-no-stray-ddl` baseline.
- **DD4 "adapter <~2 KB" re-scoped to "zero inline compute logic"** for I/O-heavy seams — §C; a daily-batch node with 85 migrations + SQL + HTTP cannot be 2 KB, and 2.4/4.2 will hit the same wall; the honest bar is "no business/compute logic remains embedded." **Flagged for the program doc's DD4 row when 2.2 lands.**
- **Golden vectors captured by executing the CURRENT node text via the `rehearse-devices-rebuild.js` facade-shim technique** — §D; proves behavior-identity to what ships today, not to a re-derivation.
- **Weather HTTP stays adapter-side, stubbed in the harness** — §D-2, Non-goals; it is not compute and would make the vectors non-deterministic.
