# Refactor Program 2026 — Status & Open Decisions (for later senior/Fable review)

**Companion to** [`refactor-program-2026.md`](refactor-program-2026.md). Records program completion status and the small set of decisions worth a stronger-model sanity check when budget allows. Everything not listed here was Opus-written and Opus-reviewed (adversarial round per item) and is committed.

## Status (2026-07-08): all program items have spec + plan

Every Phase 0–5 item is documented (spec+plan, or plan-only / runbook where noted) and on `main`. **Documentation only — nothing executed.** Execution (worker agents against these plans, producing unmerged PRs) is the next phase, gated by the hard orderings below.

**Hard merge/execution orderings (discovered during production, do not violate):**
- **1.A1 (osi-lib loader) merges before item 0.1 deploys** — three bare-`require` nodes on undeployed `main` would otherwise ship the history-sync path dead.
- **1.B4 (sync poison-pill + dead-letter) merges AND deploys before the Uganda catch-up (2.1/#87)** — a weeks-stale gateway replaying backlog into today's batch-wide transaction is the outage trigger.
- **0.3 (Stage 0 canonicalization) before 1.B1 (Stage 1 runner) before 4.3 (Stage 2 boot-DDL removal).** 4.3 additionally gated on: two clean fleet deliveries incl. Uganda + fleet-wide `schema_sig` convergence + the 5.2 kill-9-mid-migration rehearsal.
- **1.B3 (server CI) is the runway for 1.B4's Testcontainers tests** (landable either order; CI must exist to auto-run them).
- **MClimate ordered migrations = 0006–0009** (0005 is Stage 0's `analysis_views`); all plans use `ls database/migrations/ordered/` as the authoritative next-number check.

## DD corrections applied during production (already in the docs; noted for the record)

- **DD11** (program map, corrected): the osi-server cyclic core is a **12-package SCC** (15 mutual pairs; only `chameleon`/`channels`/`config` cycle-free), and `sync` imports 13 `analytics` classes — so the ArchUnit cycle rule ships as `FreezingArchRule` + committed baseline (the DD3 ratchet), and the directional rule is `analytics ↛ sync` (true today), not the DD11-illustrative `sync ↛ analytics` (false today).
- **1.B1:** the `sqlite3` CLI is **not** on the gateway image (`# CONFIG_PACKAGE_sqlite3-cli is not set`) though `cliRunner`/`backup.js` need it — the spec provisions it; and `deploy.sh` never stops Node-RED, so the spec adds a trap-guarded stop/restart.
- **1.A3:** a full test suite (`scripts/test-history-helper.js`, CI-wired) already existed — the item was re-scoped from "add tests" to "co-locate the existing suite" per DD4's actual "co-located tests" wording.
- **5.6:** `last_triggered_at` is populated but **not enforced** by the current scheduler — the backward-jump double-fire guard is genuinely new (and must cover both the SWT and DENDRO fire branches — the 5.6 reviewer caught the DENDRO branch unguarded).
- **2.3:** DD5 refinement — `channels.json` is field-name truth for dendro **inputs** (telemetry); daily-aggregate **outputs** share vocabulary via the `dendrometer_daily` table schema. Shared pure unit is `EnvelopeTwd.compute`, not the DI-bound service.

## Open decisions — candidates for a later senior/Fable consult

Ranked by stakes. None block documentation; several are execution-time gates.

1. **MClimate T-Valve firmware auto-close (DD17 farm-safety).** If the vendor datasheet shows the valve has **no device-side auto-close / duration bound**, its open downlink **cannot ship** under the actuator-safety invariant (3.0). This is a hard execution-time gate recorded in the MClimate spec — resolve when the datasheet is in hand. *Highest stakes: an actuator that can be left open is crop/water damage.*
2. **3.4 (applier split) shipped without an independent review round** — its reviewer subagent died mid-review. The writer self-verified with real line numbers throughout and the content is well-grounded (correctly consumes 1.B4's `applyOne`/`SyncOpDispatcher` boundary; `GATEWAY_LOCATION_UPSERTED` first applier on a narrowest-dependency argument), but it is the one item lacking a second pair of eyes. *Worth a read before executing 3.4.*
3. **5.3 migrate-vs-flip ordering.** On today's `deploy.sh`, `ensure_*` migration runs **after** the flow write; 5.3's auto-rollback flips the payload symlink but (correctly, per DD10) does not auto-undo the DB migration. When **1.B1** lands it re-orders to migrate-before-flip; the interaction of 5.3's rollback with 1.B1's writers-stopped/backup path deserves a sanity check at that merge point.
4. **4.2 helper-bound dispatchers stay adapter-local.** The seven `osiHistory.*`-bound dispatchers in the History API Router remain in the thin adapter rather than moving into the extracted module (rejected injecting helper fns to avoid coupling). Fine as-is; revisit only if a future item wants them under the cross-repo contract.
5. **2.4 / 4.2 agronomy-formula purity.** VPD / THI / dew-point / crop-coefficient / ET compute is moved as behavior-preserving (golden vectors freeze current shipped output). If any of those formulas has a latent correctness question, it is a **separate** post-extraction PR, not a blocker — but a domain expert should eventually eyeball the frozen outputs.
6. **1.A5 retention default = 30 days** (not the pre-ruled 7). Ruled 2026-07-08: delivered rows are already cloud-side and the new size cap does the real bounding of undelivered growth; 7 had no farm-data upside. One-line change if a reviewer prefers 7; cap logic unaffected. *Considered resolved; recorded for completeness.*

## Review-depth caveat (honest accounting)

The Phase 0/1 core set (0.2, 0.3, 1.A1, 1.B3, 1.B4) had the deepest review (Fable adversarial rounds with independent code verification). Phases 2–5 were produced under an Opus-only, budget-constrained regime: Opus writer + one Opus adversarial reviewer per item, dry-run-verified where a harness existed. Recovered-orphan items (2.3, 5.1, and the 5.2/5.3/5.6 specs) were committed after a coordinator spot-check of load-bearing claims rather than a full second round. All are documentation, not code; the real gate is the per-item review at execution time.
