# Option B Stage 2 — Boot-Node DDL Removal

**Status:** Spec — refactor-program item **4.3**, issue #88 (Stage 2). The FINAL Option-B stage. **Heavily gated** (see Gates); this spec is the design of record but is NOT executable until every gate is met.
**Scope:** osi-os edge only — removes the inline DDL from the FROZEN `sync-init-fn` boot node (both flows profiles) and the request-path DDL in two function nodes. `sync-init-fn` becomes read-only schema-state reporting (a status line; the `schema_sig` heartbeat field is computed read-only in its own health path, not by this node mutating anything). No runner change, no new schema, no Uganda-specific work here (Uganda is a *gate*, via item 2.1). (Note: `verifyHead` is the runner's deploy-time check, not something the boot node calls — the boot node does not load `lib/osi-migrate`.)
**Governs:** [`docs/superpowers/plans/2026-07-05-option-b-boot-path-cutover.md`](../plans/2026-07-05-option-b-boot-path-cutover.md) §4 (the settled Stage 2 shape) and §1.2 (the stray-DDL CI guard that makes removal safe). Depends on Stage 1 (item 1.B1) being the live schema-delivery path, proven fleet-wide.
**Domain law:** `.claude/skills/osi-schema-change-control/SKILL.md` — this spec is the **sanctioned unfreezing of `sync-init-fn`**; the full boot-node merge gate (four verifiers + production-copy rehearsal) applies.

## Problem

`sync-init-fn` ("Sync Init Schema + Triggers", node id `sync-init-fn`, byte-identical in both flows profiles) runs inline DDL on **every boot on every live Pi**. Verified current counts in the maintained bcm2712 profile:
- **93** `ADD COLUMN` statements (the large majority idempotent against a schema that already has the column; errors swallowed in a `try{}catch(_){}` sweep — 81 redundant with the seed per AGENTS.md).
- **2** `writable_schema` references (the legacy surgery block; plan §1.1 retires it separately).
- **30** `DROP TRIGGER IF EXISTS` + **30** `CREATE TRIGGER` (the trigger convergence — this is behavior, not just schema; see Boundary below).
- The sanctioned fail-closed `devices`-CHECK rebuild block (PR #86) — ~5 `devices_new` statements (7 raw string occurrences of `devices_new`; the count is the rebuild block, not a literal grep total).

Separately, **request-path DDL** runs `CREATE TABLE IF NOT EXISTS valve_actuation_expectations` in **two** function nodes (verified: `zone-env-fn` "Get Zone Environment Summary" and `get-actuations-query` "Build Query") — DDL executed on an HTTP request path, the other genus the stray-DDL guard freezes.

This inline boot-DDL is the last piece of the pre-runner schema world. It is why a gateway on the wrong schema is currently self-healing on boot (good) but also un-auditable and un-versioned (bad) and blocks the runner from being the sole schema authority. Once Stage 1 delivers schema via the ledgered runner and the fleet has converged, the boot-DDL is dead weight whose *removal* makes the runner the single source of truth (ADR goal). **Stage 2 removes it — but only after the fleet is provably safe without the on-boot self-heal.**

## Why this is the riskiest one-way door in the program

Refactor-program "Risks & one-way doors": *"Option B Stage 2 (boot-DDL removal) — a gateway on the wrong schema becomes field-unrecoverable."* Today, a gateway that somehow lands on a wrong schema is silently repaired on the next boot by `sync-init-fn`. Remove that, and a schema-wrong gateway stays wrong until a human intervenes — at a remote farm, over an intermittent link. So the gates are not ceremony; they are the difference between a recoverable and an unrecoverable fleet.

## Gates (ALL must be TRUE before execution — from refactor-program + plan §4/§5)

| # | Gate | Source |
|---|---|---|
| GA | **Two clean fleet deliveries via 1.B1 INCLUDING Uganda.** Every live gateway (kaba100, Silvan, Uganda) has received schema through the Stage-1 runner path, twice, with no failure. | refactor-program 4.3 row; "one-way doors" |
| GB | **Fleet-wide `schema_sig` convergence for a sustained window.** Every gateway's heartbeat reports the same head `schema_sig` continuously for a defined period (not a single sample). | refactor-program 4.3 row |
| GC | **Power-loss-mid-migration rehearsed on the 5.2 chaos/soak rig.** The failure the boot-node self-heal currently masks — a migration interrupted by power loss — must be proven survivable by the runner+restore path alone, without the boot node. **5.2's spec is Batch D's; this spec references it as a hard dependency, does not author it.** | refactor-program 4.3 row + 5.2 (Phase 5) |
| GD | **item 2.1 (Uganda catch-up) COMPLETE** — Uganda baselined + on the runner path (2.1 is itself gated on 1.B4 + demos; GA subsumes it but 2.1 is the concrete deliverable). | plan §5; 4.3 `Depends on … 2.1` |

If any gate is unmet, this spec is design-only. The plan (companion doc) will carry a NOT-READY banner mirroring these gates until evidence exists.

## What Stage 2 removes (and what it deliberately keeps)

### Removes
1. **The ~93 `ADD COLUMN` sweep** in `sync-init-fn` — superseded by the runner delivering every column via ordered migrations (Stage 1). A baselined+migrated gateway already has every column; the sweep is a no-op there, and after Stage 1 no gateway reaches boot without having gone through the runner.
2. **The inline table/trigger CREATE DDL** in `sync-init-fn` beyond the kept rebuild (see below). Tables/indexes/triggers are owned by the seed + ordered migrations; the runner (or a fresh seed) creates them.
3. **The 2 `writable_schema` references** — the legacy surgery. (plan §1.1 may have already retired these in the near-term decoupled work; if so, Stage 2 confirms they are gone rather than re-removing. Verify current state via `verify-no-stray-ddl.js`.)
4. **The request-path DDL:** the `CREATE TABLE IF NOT EXISTS valve_actuation_expectations` in `zone-env-fn` and `get-actuations-query`. The table becomes seed/migration-owned; the request path assumes it exists (as it must, post-baseline). This removes the last request-path DDL genus the stray-DDL guard tracks.

### Keeps (deliberately, per plan §4)
- **The guarded fail-closed `devices`-CHECK rebuild (the `devices_new` rebuild block, PR #86) for ONE release after Stage 1**, as belt-and-suspenders, **then strips it in a follow-up**. Rationale: it is a *safety* rebuild (converges a drifted `devices` CHECK), the one place where the boot node's self-heal is still valuable during the transition. Removing it in the same release as everything else would remove the last safety net before the runner path has fully proven itself in the field. So Stage 2 is two sub-steps: (2a) remove the sweep + inline DDL + request-path DDL, keep the `devices` rebuild; (2b) one release later, strip the `devices` rebuild too — at which point `sync-init-fn` is purely read-only.
- **The trigger convergence — with a caveat (Boundary below).** Until Stage 2, live trigger bodies are owned by the deployed flows (`sync-init-fn` DROPs+CREATEs all 30 on boot). This is *behavior* the seed/runner must also own before the boot convergence can go. See Boundary.

## Boundary: trigger convergence is behavior, not just schema

The 30 `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` in `sync-init-fn` do more than create triggers once — they **reconverge trigger bodies to the deployed flows' version on every boot**. This is how a gateway that booted old flows gets its trigger logic updated. (Note the accounting: the seed defines **31** triggers; `sync-init-fn` reconverges **30 of them**. The 31st, `sync_dendro_to_readings`, is boot-created by `dendro-compute-fn` "Daily Dendrometer Analytics" — out of Stage 2 scope — so ONE trigger's boot convergence survives this stage.) Stage 0/1 established that the seed's trigger set == the current flows' (enforced by `verify-runtime-schema-parity.js`), and ordered migrations own trigger DDL going forward. But removing the boot convergence of those 30 means **trigger-body updates must be delivered by the runner** (a migration that `DROP`s + `CREATE`s the changed trigger) instead of on every boot. Stage 2 therefore requires: any future trigger change ships as an ordered migration (already the rule post-freeze), and the runner path is the delivery mechanism (Stage 1). This spec removes the boot convergence **only after** confirming (via the gates) that the runner has delivered the current trigger set fleet-wide — otherwise a gateway could be left with stale trigger logic and no reconvergence. This is the subtlest part of the removal and is called out as its own rehearsal check (§ Rehearsal).

## The removal is a `flows.json` edit of the FROZEN node — the sanctioned unfreezing

Per `osi-schema-change-control`, `sync-init-fn` is FROZEN and the freeze has exactly one sanctioned exception (the `devices` rebuild). **This spec is the sanctioned unfreezing moment** — the whole point of the freeze was to make Stage 2 tractable, and this is Stage 2. Because it edits the frozen node, **the full boot-node merge gate applies** (verified list from the skill):
- `node scripts/verify-runtime-schema-parity.js` — **must be UPDATED as part of Stage 2** (verified gap): today (`scripts/verify-runtime-schema-parity.js:50-53`) it asserts the WHOLE flows.json text contains all 31 canonical trigger names by regex. Removing the 30 `CREATE TRIGGER`s from `sync-init-fn` drops the flow's trigger set to 1 (`sync_dendro_to_readings`, still in `dendro-compute-fn`) and this verifier would FAIL. Stage 2 must change its trigger-parity check so it no longer requires the triggers to appear in the flows *text* — the triggers are now owned by the seed + ordered migrations (delivered by Stage 1), not by the boot node. The correct new check: the canonical seed trigger set (31) is enforced by `verify-seed-replay.js`/`verify-db-schema-consistency.js` (schema owners); `verify-runtime-schema-parity.js`'s remaining job is the `devices_new` CHECK parity (still in the kept rebuild) plus asserting the ONE boot-created trigger (`sync_dendro_to_readings`) is present in flows. This verifier edit is IN SCOPE for Stage 2 (it is the direct consequence of the trigger-convergence boundary) and must land in the same change, or `verify-runtime-schema-parity` red-blocks the merge. The devices-CHECK half of the verifier is unchanged.
- `node scripts/verify-profile-parity.js` (bcm2712 == bcm2709 byte-for-byte).
- `node scripts/verify-devices-rebuild-fence.js` (the kept `devices` rebuild is still fail-closed — until 2b removes it).
- `node --test scripts/rehearse-devices-rebuild.test.js` (4 seeded cases still green — until 2b).
- Plus `node scripts/verify-sync-flow.js` (its own workflow) and `node scripts/verify-no-stray-ddl.js` — the latter's counts must **drop** (removing DDL lowers the per-surface marker counts; the guard bans only net increases, so a large decrease is expected and allowed, and the committed `verify-no-stray-ddl-baseline.json` documentation snapshot should be regenerated with `--write-baseline` to reflect the new, lower reality).
- **A production-copy rehearsal** before rollout (the skill's additional expectation for any boot-node touch), on a fresh byte-copy of each gateway.

**Correction on the source-plan phrasing "Greens verify-sync-flow's `data_invalid` class":** verified — `data_invalid` is a *column-fragment* the verifier checks inside the `trg_dp_chameleon_readings_outbox_ai` trigger contract (`verify-db-schema-consistency.js`), NOT a verify-sync-flow "error class" about boot-DDL. Stage 2 does not "green a data_invalid class"; what it does is make `verify-sync-flow` (and the parity verifiers) pass with a `sync-init-fn` that no longer carries DDL. This spec states the accurate gate (the verifier set above) rather than repeat the plan's imprecise shorthand.

## Rehearsal (production-copy, per gateway, before rollout)

On a fresh byte-copy of each gateway's DB (post its Stage-1 migration to head):
1. Deploy the Stage-2 flows (DDL-stripped `sync-init-fn`) to a throwaway Node-RED against the copy; boot it.
2. **No schema-related errors on boot** — the DDL-less boot node reports schema state read-only (status line; `schema_sig` via the existing health path) and attempts NO DDL. It must find the schema already at head (delivered by Stage 1). (Deploy-time `verifyHead` — a runner check — is separate; the boot node does not call it.)
3. **Trigger-set intact** — assert all **31** seed triggers are present and match the seed (the runner delivered the 30 that `sync-init-fn` used to converge; the 31st, `sync_dendro_to_readings`, is still boot-created by `dendro-compute-fn` "Daily Dendrometer Analytics", which is OUT of Stage 2 scope — so it survives). The boot node no longer reconverges its 30 — this step proves the runner path actually delivered the current bodies (the Boundary concern). Under-asserting by even one trigger on the program's riskiest one-way door is unacceptable, so the check is the full 31.
4. **Request path works without its DDL** — exercise the `zone-env-fn` / `get-actuations-query` paths; `valve_actuation_expectations` must already exist (seed/migration-owned) so the CREATE-removal is invisible.
5. **`devices` rebuild still fires when needed (2a only)** — a drifted-CHECK copy still converges via the kept rebuild; after 2b, this rebuild is gone and a drifted CHECK is instead a runner/baseline concern.
6. **Power-loss-mid-migration (GC / 5.2 rig):** prove that a migration interrupted mid-way, on a boot node that no longer self-heals, is recovered by the runner's ledger + restore path alone — the failure mode the boot DDL currently masks.

Any rehearsal failure holds that gateway's Stage-2 rollout.

## Rollout

Same canary-gated order as Stage 1, and only after the gates: demos (kaba100 → Silvan) first, each post-verified via `schema_sig` + the 0.2 canary gate for a sustained window, THEN Uganda. **2a** (strip sweep/DDL/request-path, keep `devices` rebuild) rolls out fully and holds for one release; **2b** (strip the `devices` rebuild, `sync-init-fn` becomes purely read-only) is a separate later change on the same gate discipline.

## Non-goals

- **Authoring the 5.2 chaos/soak rig** (GC) — Batch D's; referenced as a dependency only.
- **item 2.1 Uganda catch-up** — a gate (GD), its own runbook.
- **Changing the runner or adding migrations** — Stage 2 removes boot DDL; it does not add schema.
- **Removing the `devices` rebuild in this slice** — that is sub-step 2b, one release after 2a.
- **The `writable_schema` retirement** if plan §1.1 already did it — Stage 2 confirms, not re-does.

## Definition of Done

- **2a:** `sync-init-fn` (both profiles, byte-identical) has the ~93 `ADD COLUMN` sweep + inline table/trigger CREATE DDL + `writable_schema` block removed; it runs read-only schema-state reporting (status line; `schema_sig` via the health path) + the kept `devices` rebuild (the only remaining DDL, all within the fail-closed rebuild block). The two request-path `CREATE TABLE valve_actuation_expectations` occurrences removed. **`verify-runtime-schema-parity.js` updated** so trigger parity is no longer sourced from the flows text (the seed/migrations own the 31 triggers; the verifier keeps the `devices_new` CHECK check + asserts the one boot-created `sync_dendro_to_readings`). All boot-node merge-gate verifiers green; `verify-no-stray-ddl.js` counts dropped and baseline snapshot regenerated. Production-copy rehearsal (§Rehearsal steps 1–6, incl. GC) green per gateway, written up as evidence.
- **2b (one release later):** the `devices`-CHECK rebuild removed; `sync-init-fn` is purely read-only; `verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild.test.js` retired or repurposed (their subject is gone).
- Gates GA–GD evidence recorded in this document before execution.
- No runner change, no new schema, no live gateway touched outside the gated canary rollout.

## Open decisions

None outstanding on design. The sequencing (2a keeps the `devices` rebuild one release, 2b strips it) is settled by plan §4 ("keep the guarded fail-closed devices rebuild for one release after Stage 1 … then strip"). The one factual correction (the "data_invalid class" phrasing) is resolved above. The 5.2 rig's existence is a hard external gate (GC), not an open decision here.
