# Refactor Program 2026 — Status & Open Decisions (for later senior/Fable review)

**Companion to** [`refactor-program-2026.md`](refactor-program-2026.md). Records program completion status and the small set of decisions worth a stronger-model sanity check when budget allows. Everything not listed here was Opus-written and Opus-reviewed (adversarial round per item) and is committed.

## Status (2026-07-10): all program items have spec + plan; Fable architectural review complete

Every Phase 0–5 item is documented (spec+plan, or plan-only / runbook where noted) and on `main`. **Documentation only — nothing executed.** Execution (worker agents against these plans, producing unmerged PRs) is the next phase, gated by the hard orderings below.

**Fable independent architectural review (2026-07-10):** a full Fable review of the critical-path specs/plans, cross-item interactions, and composition seams found 2 CRITICAL, 3 HIGH, and 4 MEDIUM issues — all concentrated in the **composition seams between plans** (exactly where per-item adversarial review can't see). All have been resolved as plan/spec edits below. The architecture (DD1–DD18, phase gates, YAGNI list) was validated as sound. See §Fable review findings for the full record.

**Hard merge/execution orderings (discovered during production, do not violate):**
- **1.A1 (osi-lib loader) merges before item 0.1 deploys** — three bare-`require` nodes on undeployed `main` would otherwise ship the history-sync path dead.
- **repair-sync-outbox-v2.js runs as a pre-step of EACH 0.1 per-gateway deploy (Fable review CRITICAL 2026-07-10)** — current main's sync drain queries `sync_outbox.rejected_at`/`rejection_reason` (landed via #105); kaba100 lacks these columns; deploying current flows without the repair first breaks the outbox drain with "no such column" every 30s tick. The health helper's `catch(_){}` masks the failure as null health fields. Sequence per gateway: repair → deploy (0.1) → baseline → Stage 1.
- **1.B4 (sync poison-pill + dead-letter) merges AND deploys before the Uganda catch-up (2.1/#87)** — a weeks-stale gateway replaying backlog into today's batch-wide transaction is the outage trigger.
- **0.3 (Stage 0 canonicalization) before 1.B1 (Stage 1 runner) before 4.3 (Stage 2 boot-DDL removal).** 4.3 additionally gated on: two clean fleet deliveries incl. Uganda + fleet-wide `schema_sig` convergence + the 5.2 kill-9-mid-migration rehearsal.
- **1.B3 (server CI) is the runway for 1.B4's Testcontainers tests** (landable either order; CI must exist to auto-run them).
- **MClimate ordered migrations = 0006–0009** (0005 is Stage 0's `analysis_views`); all plans use `ls database/migrations/ordered/` as the authoritative next-number check. **Note (2026-07-10):** MClimate T-Valve and Milesight UC512 valve are both near-term candidates for Phase 3's second-consumer role (DD6). Whichever integrates first is the pilot device — the generic writer architecture is device-agnostic.

## DD corrections applied during production (already in the docs; noted for the record)

- **DD11** (program map, corrected): the osi-server cyclic core is a **12-package SCC** (15 mutual pairs; only `chameleon`/`channels`/`config` cycle-free), and `sync` imports 13 `analytics` classes — so the ArchUnit cycle rule ships as `FreezingArchRule` + committed baseline (the DD3 ratchet), and the directional rule is `analytics ↛ sync` (true today), not the DD11-illustrative `sync ↛ analytics` (false today).
- **1.B1:** the `sqlite3` CLI is **not** on the gateway image (`# CONFIG_PACKAGE_sqlite3-cli is not set`) though `cliRunner`/`backup.js` need it — the spec provisions it; and `deploy.sh` never stops Node-RED, so the spec adds a trap-guarded stop/restart.
- **1.A3:** a full test suite (`scripts/test-history-helper.js`, CI-wired) already existed — the item was re-scoped from "add tests" to "co-locate the existing suite" per DD4's actual "co-located tests" wording.
- **5.6:** `last_triggered_at` is populated but **not enforced** by the current scheduler — the backward-jump double-fire guard is genuinely new (and must cover both the SWT and DENDRO fire branches — the 5.6 reviewer caught the DENDRO branch unguarded).
- **2.3:** DD5 refinement — `channels.json` is field-name truth for dendro **inputs** (telemetry); daily-aggregate **outputs** share vocabulary via the `dendrometer_daily` table schema. Shared pure unit is `EnvelopeTwd.compute`, not the DI-bound service.

## Open decisions

Ranked by stakes. Items marked RESOLVED have been addressed as plan/spec edits.

1. **Actuator firmware auto-close (DD17 farm-safety) — OPEN, generalized.** Originally framed as MClimate-only. Now applies to **whichever valve integrates first** (MClimate T-Valve or Milesight UC512). If the vendor datasheet shows the valve has **no device-side auto-close / duration bound**, its open downlink **cannot ship** under the actuator-safety invariant (3.0). Resolve when the datasheet is in hand. **Additionally (Fable review):** the 3.0 gate is structural only — it asserts `requires_duration: true` on the registry entry. Nothing asserts the downlink **encoder** actually emits a bounded, non-zero duration byte. A codec bug (duration=0 = indefinite on many LoRaWAN valves) ships green through 3.0 and 3.2. **Action:** extend 3.2's `verify-device-integration.js` with a downlink golden-vector assertion (e.g. `encode(open, N)` differs from `encode(open, 0)`; `encode(open, 0)` rejected). *Highest stakes: an actuator that can be left open is crop/water damage.*
2. **3.4 (applier split) — RESOLVED (2026-07-08).** Independent review verified all ground-truth claims against live `EdgeSyncService.java` and the 1.B4 spec+plan. All correct; no correctness issues. Two implementation traps identified and annotated in the plan: (a) Lombok `@RequiredArgsConstructor` skips fields with initializers — `appliersByOp` must have `= new HashMap<>()` (spec §C code snippet fixed); (b) `@Import` completeness in `@DataJpaTest` slices — partial registry builds pass tests but don't match production. Review findings section added to the plan; spec §C snippet corrected. *No longer blocking execution.*
3. **5.3 × 1.B1 deploy.sh ordering — RESOLVED (2026-07-10, Fable review).** This was a CRITICAL finding, not a "sanity check." As the two plans were originally written, the composed `deploy.sh` order was flip→migrate→probe, violating DD10. On migration failure with `set -e`, the rollback block never executed. **Fix applied:** 5.3 owns the re-ordering. The stage-only write at :535 does NOT flip the symlink; the flip moves to the post-migrate block at :681. Sequence is now stage→migrate→flip+restart+probe, per DD10. 1.B1's trap clobbering and backup-on-tmpfs were also fixed (see §Fable review findings). Both plans now include a rebase protocol for whichever merges second to re-anchor line references.
4. **4.2 helper-bound dispatchers stay adapter-local — OPEN, no issues found (Fable confirmed).** The seven `osiHistory.*`-bound dispatchers in the History API Router remain in the thin adapter rather than moving into the extracted module (rejected injecting helper fns to avoid coupling). Fine as-is; revisit only if a future item wants them under the cross-repo contract.
5. **2.4 / 4.2 agronomy-formula purity — OPEN, one cost noted (Fable confirmed).** VPD / THI / dew-point / crop-coefficient / ET compute is moved as behavior-preserving (golden vectors freeze current shipped output). If any of those formulas has a latent correctness question, it is a **separate** post-extraction PR, not a blocker. **Additional note (Fable):** once 2.3 promotes dendro vectors to a cross-repo contract, a later formula correction becomes a coordinated two-repo contract bump, not a one-line fix. Record this cost; don't let it block.
6. **1.A5 retention default = 30 days — RESOLVED.** Considered resolved; recorded for completeness.

## Fable review findings (2026-07-10) — full record

All findings verified against live code in both repos. Resolutions are plan/spec edits (no code changes — execution hasn't started).

### CRITICAL — resolved

| # | Finding | Resolution | Files edited |
|---|---|---|---|
| C1 | **5.3 × 1.B1 compose into flip-before-migrate** — neither plan owned the re-order; composed `deploy.sh` violated DD10; on migration failure `set -e` skips 5.3's rollback block | 5.3 plan: stage-only at :535 (no flip); flip moves to post-migrate block. 1.B1 plan: trap chaining (not replacement). Both plans: rebase protocol added. | `plans/2026-07-08-staged-atomic-deploy.md`, `plans/2026-07-08-option-b-stage1-deploy-runner.md` |
| C2 | **1.B1's "off-device backup" lives on tmpfs** (`/tmp` is RAM on OpenWrt); trap clobbering loses `deploy.sh`'s cleanup | Backup dir → `/data/backups/migrate` (persistent ext4). Trap chaining preserves cleanup. rc=3 path restores old trap instead of cancelling all. Honest note: both copies are same SD; operator-pulled copy is the true off-SD backup (rehearsal DoD already mandates this). | `plans/2026-07-08-option-b-stage1-deploy-runner.md`, `specs/2026-07-08-option-b-stage1-deploy-runner-design.md` |

### HIGH — resolved

| # | Finding | Resolution | Files edited |
|---|---|---|---|
| H1 | **5.3 runs the cloud admin gate on the Pi** — 0.2's gate needs admin JWT; shipping it to gateways violates credential policy; offline gateways can never pass a cloud probe | Replaced with a local self-check on the Pi (Node-RED process alive + `/gui` reachable). Full cloud verdict runs operator-side after deploy exits. | `plans/2026-07-08-staged-atomic-deploy.md` |
| H2 | **1.B4 FK-orphan misclassification** — per-event tx removes FK ordering that whole-batch tx provided; child permanently dead-lettered when parent is transient-failed | Classifier: SQLState 23503 (FK violation) → RETRYABLE (not permanent). Dominant in-method door also closed: `IllegalArgumentException("Zone not found")` → `parent_missing` → RETRYABLE. Verified by Fable: the scenario is possible by construction (edge drain query has no aggregate grouping). | `specs/2026-07-07-sync-ingest-hardening-design.md` |
| H3 | **Uganda bootstrap path not covered by 1.B4** — `applyBootstrap` has same single-tx semantics; Uganda's catch-up leads with bootstraps | Accepted residual with monitoring protocol added to the 2.1 runbook. Bootstrap payloads are LIMIT-bounded and upsert-idempotent; failure mode is visible/bounded/transient. Per-collection tx hardening filed as a future round. | `docs/operations/uganda-catchup-runbook.md` |

### MEDIUM — noted/resolved

| # | Finding | Resolution |
|---|---|---|
| M1 | **5.3 stages only flows.json** (spec §A says full payload); rollback fidelity erodes as DD4 extraction proceeds | Known-limitation section added to 5.3 plan. `osiLib` quarantine (DD2) makes the degradation fail-visible. Revisit when the second extraction lands. |
| M2 | **Stage 2's request-path DDL enumeration under-counts** (claims 2 tables; 2.4/4.2 ground truth documents 7) | Noted here for the 4.3 executor to correct; Stage 2 is heavily gated and far out. |
| M3 | **3.0/3.2 missing downlink duration-encoding assertion** | Folded into open decision #1 (actuator safety, now generalized to both valves). |
| M4 | **DD3 scoreboard baseline stale** (564 nodes/1,017,468 bytes → 572 nodes/1,291,698 bytes after PRs #113/#114) | 1.A2 executor must re-capture from current main. |
| M5 | **5.3 payload staging scope diverges from behavior unit** as DD4 extraction proceeds | Same as M1; both noted in the 5.3 plan. |

### Phase 0+1 Fable review (2026-07-10, second pass) — foundation items

| # | Severity | Item | Finding | Resolution |
|---|----------|------|---------|------------|
| F1 | **CRITICAL** | 0.3/0.1 | **0.1 deploy breaks outbox drain:** current main's sync drain queries `sync_outbox.rejected_at`/`rejection_reason` (via #105); kaba100 lacks these columns; deploy breaks drain with "no such column" every 30s tick; health helper's `catch(_){}` masks it | `repair-sync-outbox-v2.js` added as a hard pre-step of EACH 0.1 per-gateway deploy (not Stage-1-only). Corrected sequence: repair → deploy (0.1) → baseline → Stage 1. Hard ordering added to program orderings. |
| F2 | **HIGH** | 0.2 | **Canary gate hard-fails on schema-changing deploys:** `accepted-schema-signatures` is static server config; a new sig from Stage 1 fails the gate until config edited + backend restarted | Gate's `--expect-schema-sig` override suppresses `schema_sig_not_accepted` when the reported sig matches the expected one. Runbook adds allowlist-update sequence after gate passes. |
| F3 | MEDIUM | 0.2 | **Error-delta baseline is sticky:** one transient error early in window fails all subsequent polls on criterion 4 | Re-baseline the error-delta on each failed-poll reset (judge "still rising" not "ever rose"). |
| F4 | MEDIUM | 0.3 | **Comparator omits FOREIGN KEYs:** FK divergence still classifies `extra_forward` | Added `PRAGMA foreign_key_list` to the comparator taxonomy. |
| F5 | MEDIUM | 1.A5 | **Batched eviction needed:** single DELETE of 10K+ rows holds write lock beyond `busy_timeout=5000`, dropping concurrent sensor INSERTs | Batched DELETE (LIMIT 1000 loop) + new `idx_sync_outbox_eviction` index added to spec. |
| F6 | MEDIUM | 1.B3 | **Flyway rollback blind spot:** rolling image back across a migration-bearing deploy leaves DB at newer schema; older image may fail | Runbook checklist item: "If deploy included Flyway migrations, rollback = image repoint + PG dump restore." |
| F7 | LOW | 1.A1 | **Post-deploy `npm install` failure → osi-lib queue-forever brick:** D2 guard is merge-time only | Cheap deploy.sh post-check noted (`node -e "require('/srv/node-red/node_modules/osi-lib')"`) |
| F8 | LOW | 1.A5 | **`record-error-fn` 60s throttle claim incorrect:** `counts.total` increments unconditionally; only `node.warn` is throttled | Spec text corrected (harmless at daily cadence). |

### Cross-cutting: merge/deploy sequencing (corrected)

The verified safe execution order for Phase 0+1 is:
1. **1.A1 merges** (osi-lib loader — must precede any deploy of current main)
2. **0.2 merges** (canary gate tooling — needed for deploy verification)
3. **0.3 merges** (Stage 0 tooling — baseline-existing-db.js, comparator, repair script)
4. **Per-gateway deploy window:** `repair-sync-outbox-v2.js` → deploy 0.1 (current flows) → baseline → (later) Stage 1
5. **1.B3** (server CI) and **1.B4** (sync hardening) — parallel, either order, but both before Uganda

Items 0.2, 0.3, and 1.A1 all append to the same `migrations.yml` test line and 0.2/1.A1 both mutate `flows.json` — land them sequentially, rebasing against the merged state.

### Phase 2 Fable review (2026-07-10, third pass) — extraction pattern

| # | Severity | Item | Finding | Resolution |
|---|----------|------|---------|------------|
| G1 | HIGH | 2.3 | **Cross-repo fixture format overstates the feasible intersection:** edge has no `anchor_eligible`/`maxGrowthUmPerDay`; server rounds at a different layer; linear method not real in `EnvelopeTwd.compute` | Fixture constraints tightened: stepwise-only, integer µm, all-eligible, cap disabled. Plan Task 1 must use spec's `DailyPoint` shape, not 2.2's E2E shape. |
| G2 | MEDIUM | 2.3 | **Plan/spec input-format contradiction:** plan Step 1.1 uses 2.2's E2E shape; spec §A mandates `DailyPoint` | Noted for executor to reconcile — spec wins. |
| G3 | MEDIUM | 2.4 | **Three module-level constants omitted from mover list:** `LOCAL_METRICS`, `DEVICE_ONLY_METRICS`, `KC_BY_STAGE` — movers close over them → `ReferenceError` without them | Noted for executor — 2.2 enumerated its constants; 2.4 must too. |
| G4 | LOW | 2.2 | **Golden-vector harness needs `require` stub** for dendro's `requestJson` calling `require('https')` | Noted in plan — stub mechanism needed in Step 2.2. |
| G5 | LOW | 2.4 | **Request-path DDL total is 10 across flows.json**, not 7 — adds `get-zones-query` (1) + `zone-calibration-fn` (1) | Passed to 4.3 executor alongside the CRITICAL correction. |

**2.2 verdict:** execution-ready. **2.4 verdict:** execution-ready after adding three constants to §A. **2.3 verdict:** needs fixture-format tightening before execution.

### Phases 3–5 Fable review (2026-07-10, fourth pass)

| # | Severity | Item | Finding | Resolution |
|---|----------|------|---------|------------|
| H1 | **CRITICAL** | 1.A2 | **Ratchet blocks 3.1 and 5.6 as planned:** Rule 1 (no node may grow) fails 5.6; Rule 2 (total may only decrease) fails 3.1. Neither downstream plan mentions the ratchet. | Growth-allowance mechanism added to 1.A2 plan: committed `allowances.json` with per-node deltas + total delta, consumed-or-deleted. Downstream plans must cite allowances. |
| H2 | **CRITICAL** | 4.3 | **Stage 2 DDL enumeration wrong (2 vs 10 CREATEs):** spec claims 2 tables in 2 nodes; actual is 10 across 5 nodes, including 3 deferred from 4.2. Guard test contradicts DoD. | Spec corrected with full 10-CREATE enumeration. Sub-step 2a removal list must cover all. |
| H3 | HIGH | 3.1 | **UC512 is a two-channel valve controller:** the entire actuation model assumes one valve per deveui. Per-channel command addressing needed. | Noted for UC512 spec rewrite — the MClimate spec's architecture is ~80% reusable but actuation model needs redesign. |
| H4 | HIGH | 5.1 | **`boot-db-integrity-check.js` not shipped to image:** `scripts/` is not imaged; init.d invokes a nonexistent on-device path. | Noted — needs an imaged-path delivery task. |
| H5 | HIGH | 5.2 | **Chaos rig pass criteria too weak for 4.3 gate:** no mid-apply SIGKILL hit required; no destructive migration exercised in fixtures. | Noted — ≥1 `drift_halt` observation + 0004-shaped destructive migration must be hard pass criteria. |
| H6 | HIGH | 5.6 | **Blocked by 1.A2 ratchet conflict** (all three edits grow existing nodes) | Resolved by H1's growth-allowance mechanism. |
| H7 | MEDIUM | 4.2→4.3 | **DDL handoff gap:** 4.2 defers `ensureHistoryTables` to 4.3; 4.3 doesn't pick it up | Covered by H2's corrected enumeration. |
| H8 | MEDIUM | 5.6 | **Timestamp clamp only covers one node;** other per-device sql-fns also derive `recorded_at` from device clock — unaudited | Noted for executor — audit all `recorded_at` derivation paths. |
| H9 | MEDIUM | 5.2→5.6 | **`clock_jump_forward` event asserted by 5.2 but never built by 5.6's plan** | Noted — 5.6 plan must add the forward-jump flag or 5.2 must drop the assertion. |
| H10 | MEDIUM | 4.3 | **Plan Step 0.2 expects `devices_new: 7`; live count is 5** — stale baseline | Noted for executor — re-verify at execution time. |

**3.1 UC512 reusability:** ~80% of the MClimate spec is device-agnostic (normalize contract, writer, shadow mode, round-trip gate). ~20% is device-specific (codec, normalizer fields, ChirpStack profiles). The two-channel valve model (H3) is a genuine design delta.

### Rebase protocol (cross-cutting)

All plans that anchor edits on `deploy.sh` line numbers (1.B1, 5.3) now include a rebase protocol: re-verify line references against current main before executing; if anchor text is gone, STOP and reconcile. This addresses the drift observed in the first executed plan.

## Review-depth caveat (honest accounting)

**All phases are now Fable-reviewed.** Four Fable review passes (2026-07-10):
1. Composition seams (5.3×1.B1, 1.B4 classifier, Uganda bootstrap, 0.2 probe) — 2 CRITICAL + 3 HIGH found and fixed.
2. Phase 0+1 foundation (0.3, 0.2, 1.A1, 1.A5, 1.B3) — 1 CRITICAL + 1 HIGH found and fixed.
3. Phase 2 extractions (2.2, 2.3, 2.4) — 1 HIGH found (2.3 fixture format), fixes noted.
4. Phases 3–5 (1.A2 ratchet, 3.0/3.1, 4.2/4.3, 5.1/5.2/5.6) — 2 CRITICAL + 4 HIGH found and fixed/noted.

Total across all passes: **5 CRITICAL**, **9 HIGH**, **15+ MEDIUM** — all resolved as spec/plan edits or noted for executor attention. The architecture (DD1–DD18, phase gates, YAGNI) is validated as sound. All dangerous defects were concentrated in composition seams between plans and in ground-truth claims that drifted from live code.
