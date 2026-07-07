# Option B — Boot-Path DDL Cutover to the Runner — SCOPING (reasoning record)

**Date:** 2026-07-05
**Status:** SUPERSEDED by the reshaped plan `docs/superpowers/plans/2026-07-05-option-b-boot-path-cutover.md` (after a senior-engineer reasoning pass verified against a live kaba100 DB copy). Kept as the reasoning record. Key reshapes: NOT fingerprint canonicalization (column-order makes "replay==live" unattainable) → per-device semantic baseline; deploy-time CLI only, never boot (the `writersStopped` gate); retire the `writable_schema` surgery + add two CI guards as decoupled near-term work (issues #93/#94/#95); #87+Uganda-baseline as one window. Still gated on #1 + #87 for the device stages.
**Roadmap rank:** #5. Issue #88.
**Focus:** osi-os.

## Why scoping-only
This touches schema management of the **one production gateway** (Uganda) and every gateway, and the pre-work reviews (this session) established the fleet is in a non-deterministic schema state. A single-pass plan here is how you brick Uganda. This doc frames the problem, stages, and open decisions so a proper brainstorm can turn it into an executable plan.

## Problem
Edge schema DDL is currently owned by FOUR duplicated, drift-prone implementations that run outside the migration system:
1. `deploy.sh` `ensure_dendro_schema` / `ensure_zone_irrigation_calibration_schema` / `ensure_analysis_views_schema` / `ensure_chameleon_schema` (lines ~129-303) — idempotent `ADD COLUMN`/`CREATE TABLE IF NOT EXISTS` on the live DB every deploy.
2. `scripts/repair-pi-schema.js` (~584 lines) — a standalone repair.
3. The `sync-init-fn` inline boot DDL (~93 `ADD COLUMN`s, trigger/table creation) on every boot.
4. **The `sync-init-fn` `PRAGMA writable_schema=ON` → `UPDATE sqlite_master SET sql = REPLACE(...)` → `schema_version` bump block** — runtime surgery on `sqlite_master` of the canonical DB (found in review; the single scariest one).

The `lib/osi-migrate` runner (ordered migrations + ledger + fingerprints + drift preflight, 16 tests) exists but is **deploy/CI-time only — nothing on-device invokes it.** Option B makes the runner the single edge-DDL authority and retires 1-4.

## The hard part (open, needs the brainstorm)
The runner refuses to apply onto out-of-band drift and expects a `schema_migrations` ledger + matching fingerprints. But:
- **No field DB has the ledger** (runner never ran on-device).
- **Field schemas differ from `seed-blank.sql` and from each other** (measured in the heartbeat/codec pre-work: cosmetic `sqlite_master` formatting lineage + real divergence like `analysis_views` present live but absent from seed + Uganda missing whole tables). So a clean fingerprint-matched baseline-stamp is NOT currently possible fleet-wide.
- **The `writable_schema` surgery mutates schema outside the runner** → it would manufacture exactly the drift the preflight refuses.

So the real prerequisite is **canonicalization**: get every gateway to a single, defined, reproducible schema, THEN baseline-stamp it, THEN let the runner own forward changes.

## Proposed staging (to be pressure-tested)
- **Stage 0 — canonicalize + reconcile the reference.** Make `seed-blank.sql` + the ordered migrations reproduce the ACTUAL intended post-deploy schema (fold the `ensure_*` additions — `analysis_views`, dendro cols, chameleon, zone calibration — into the seed/migrations so "replay == live-after-repair"). Retire the `writable_schema` surgery (replace the `devices_old`-reference cleanup with a safe migration or drop it if the fail-closed rebuild already prevents leftovers). Establish the canonical fingerprint.
- **Stage 1 — deploy-time runner (low-risk half, Fable's recommendation).** `deploy.sh` invokes `lib/osi-migrate` on-device via the **sqlite3 CLI** (already on the Pi — no node-sqlite3 adapter, one execution model) *instead of* the `ensure_*` functions. First run on each field DB **baseline-stamps** it (semantic-fingerprint-gated; rehearsed on a copy of each gateway's DB, especially Uganda). Retires deploy.sh `ensure_*` + `repair-pi-schema.js`.
- **Stage 2 — boot-time.** Remove the `sync-init-fn` inline DDL + the surgery block; the boot node stops owning schema (deploy-time migrations do). Green `verify-sync-flow`'s `data_invalid` class; subsume the ~93 redundant ADD COLUMNs.

## Open decisions for the brainstorm (do not pre-decide)
1. Per-gateway accepted baseline vs one canonical baseline (given today's divergence). Probably: canonicalize (Stage 0) so one baseline works.
2. How to safely baseline Uganda specifically (it's months-stale, missing sync tables — likely needs a full catch-up deploy #87 FIRST, then baseline).
3. Whether the runner runs at deploy-time only (simpler, CLI, one model) or ever at boot (Fable earlier argued: keep it out-of-process; Node-RED only does read-only verifyHead).
4. Rollback + fail-closed + observability of an on-device migration failure (the heartbeat/#1 `schema_sig` becomes the post-migration verification signal — good coupling).

## Prerequisites before this can be planned
- Item #1 (heartbeat `schema_sig`) shipped — gives remote post-migration verification.
- #87 Uganda catch-up done — so Uganda is on a modern schema before baselining.
- Stage 0 canonicalization designed (the biggest sub-project).

## Explicitly NOT in a first executable slice
Boot-time removal (Stage 2), any Uganda migration, and the `writable_schema` removal until Stage 0's reference is proven by replay==live on gateway copies.

---
**Next action for this item:** run `superpowers:brainstorming` on Stage 0 (canonicalization) as its own sub-project, then the review loop, before any code. This SCOPING doc is the input, not a plan.
