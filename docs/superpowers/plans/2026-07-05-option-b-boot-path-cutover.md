# Option B — Boot-Path DDL Cutover to the Runner — Staged Plan

**Date:** 2026-07-05
**Status:** Gated. The **near-term decoupled items** (§1) are executable NOW as small PRs. **Stages 0–2** must wait for prereqs (#1 heartbeat + #87 Uganda catch-up) and each needs a rehearsal-on-copy before touching a device. Reshaped from `…/specs/2026-07-05-option-b-boot-path-cutover-SCOPING.md` after a senior-engineer reasoning pass (verified against a live kaba100 DB copy).
**Roadmap rank:** #5. Issue #88.

## Decision (verified)
Do it now, staged — the ADR's own promotion trigger has **already fired**: a real production-bound schema change (history-sync-v1's `sync_outbox.rejected_at`/`rejection_reason`/`last_retryable_failure_at`) is **in `seed-blank.sql` but missing from the live kaba100 DB, and no on-device/ops healer adds it** (verified: 0 refs in sync-init-fn and repair-pi-schema.js). The ad-hoc DDL system has demonstrably failed at its one job; Uganda additionally has no `sync_outbox` at all (zero cloud backup). ~85% of the mechanism (runner, ledger, fingerprints, backup, seed-replay CI) is already built and tested.

**Two decisions that reshape the scoping doc:**
- **NOT fingerprint canonicalization ("replay==live").** Fingerprints include column *order* (`table_xinfo` cid); live DBs got columns via `ADD COLUMN` in boot order, the seed declares them inline → fingerprints can never match without rebuilding ~36 tables/device (the history-loss risk class) for zero functional value. Instead: a **semantic** reference (order/whitespace-insensitive) + **per-device adopt-current baseline** gated by a semantic comparator, converging forward. The runner's preflight is already per-device (`runner.js:17-25`); `restamp-fingerprints.js` exists.
- **Deploy-time via the `sqlite3` CLI, NEVER at boot — permanent rule.** The runner refuses destructive migrations unless `writersStopped` (`runner.js:47-49`); at boot inside Node-RED you can't assert that, so a boot runner could only do additive work (not the rebuilds it exists for), and would fire on unattended power-cut reboots at a remote site. Boot gets **read-only `verifyHead` + heartbeat `schema_sig`** only.

## §1 — Near-term, decoupled, executable NOW (filed as separate issues)
These do not depend on #1/#87 and are low-risk. Do them first.
1. **Retire the `writable_schema` surgery** (its own PR). One-line read-only fleet probe `SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%devices_old%'` on all 3 gateways → if clean everywhere (kaba100 verified clean; unreachable-by-design under `legacy_alter_table=ON`), delete the block in the next flows deploy (both profiles) = deleting dead code. If Uganda has refs, fix once offline in the #87 window — never let the every-boot auto-surgery run.
2. **CI guard: ban DDL outside `database/migrations/ordered/`.** A `scripts/verify-no-stray-ddl.js` that scans both flows profiles + `deploy.sh` for `CREATE TABLE`/`ALTER TABLE`/`CREATE [UNIQUE] INDEX`/`CREATE|DROP TRIGGER`/`DROP TABLE`/`writable_schema` and **freezes the net-new DDL count per surface, git-anchored against `origin/main`** (not a self-certified committed baseline — a PR that adds DDL and also regenerates a committed baseline file in the same commit is exactly the hole this closes; review found and fixed it). Comparison is by per-surface, per-marker count (order-insensitive), so node reordering or unrelated edits can't false-positive; the committed `scripts/verify-no-stray-ddl-baseline.json` is now a compact documentation snapshot, not the enforcement gate, and supports `--write-baseline` regeneration. Catches the request-path DDL (`CREATE TABLE IF NOT EXISTS valve_actuation_expectations` runs in **two** function nodes today) and stops the genus regrowing. Wired into CI (`.github/workflows/migrations.yml`, which already fetches `origin/main`).
3. **CI guard: migration-immutability manifest.** `verify-migrations.js` only checks version contiguity; an edit to an already-applied `0001__baseline.sql` would `repair_required`-brick every stamped device. Add a committed checksum manifest of the ordered migrations and fail CI on any post-hoc edit.

## §2 — Stage 0: semantic reference + tooling (after §1; before any device work)
- Complete the **canonical semantic reference**: add `analysis_views` to `seed-blank.sql` + a new ordered migration (verified absent from both today); decide the fate of live-only `chameleon_readings.swt_1..3`; record the known sync-outbox WS2 healer gap. Keep `verify-seed-replay.js` honest for fresh DBs.
- Build `scripts/semantic-schema-compare.js` — order/whitespace-insensitive set comparison of tables/columns(name,type,notnull,pk)/indexes/triggers/CHECKs between two DBs; returns pass + the set-diff.
- Build `scripts/baseline-existing-db.js` — semantic-gate (vs reference) → write the `schema_migrations` ledger row for the head migration with the **real file checksum** (or the next run hits the checksum-repair path `runner.js:32-41`) → `syncFingerprints`. Rehearse against the kaba100 copy already in `analysis/kaba100-chameleon-zero-export-20260702/`.

## §3 — Stage 1: deploy-time runner + per-device baseline (rehearsed; demos first)
- `deploy.sh`: after `seed_db_if_missing`, run the runner via the `sqlite3` CLI (`node <migrate-cli> /data/db/farming.db`) *instead of* the `ensure_*_schema` functions. First run on an existing DB calls `baseline-existing-db.js` (semantic-gated). Retire `deploy.sh ensure_*` + `repair-pi-schema.js`.
- **Rollout:** kaba100 → Silvan (rebuildable, observe), then **Uganda's catch-up + baseline as ONE rehearsed window** (see §5). Any per-device catch-up (Uganda's missing `sync_outbox` etc.) is authored as additive migrations, rehearsed on that device's byte-copy.

## §4 — Stage 2: remove boot-time DDL (LAST, unhurried)
- Remove the sync-init-fn inline `ADD COLUMN`s + table/trigger DDL and the request-path DDL (§1.2 guard prevents new ones). Keep the guarded fail-closed `devices` rebuild for **one release** after Stage 1 as belt-and-suspenders, then strip. Greens `verify-sync-flow`'s `data_invalid` class. Node-RED does read-only `verifyHead` only.

## §5 — Uganda-specific procedure (the one irreplaceable DB)
#87 + baseline = one rehearsed window, not two. (1) heartbeat (#1) live first for remote verification; (2) exfiltrate a byte-copy in a good connectivity window (`.backup` → integrity_check → gzip → scp; check disk first); (3) rehearse the exact catch-up+baseline artifact locally on that copy (additive `CREATE TABLE sync_outbox/sync_link_state` + triggers + missing columns → runner → baseline-stamp → verify suite → boot Node-RED against it → assert history row counts unchanged); (4) on-device via ONE uploaded connection-drop-immune script (`setsid`, log-to-file, never stream statements over an intermittent link): stop Node-RED → `.backup` + integrity_check (kept on-device AND off) → run the identical artifact → postflight (`integrity_check`, `foreign_key_check`, `verifyHead ok`, row-count invariants) → restart; (5) verify remotely via heartbeat `schema_sig` + resumed sync telemetry; keep backups N days.

## Prereqs & the one non-negotiable
- Prereqs for §2+: **#1 heartbeat** (remote post-migration verification — the fleet's `sync_outbox` gaps mean this is the only way to see the result on Uganda) and, for the Uganda step, **#87**.
- **The one insurance rule:** no artifact runs on a device until the identical artifact ran green on an **exact byte-copy of that device's DB**, semantic gate passing, with the heartbeat live to verify remotely. Rehearsal-on-real-copy is the entire safety story.

## Biggest risk
A **bad baseline-stamp** — blessing a semantically-wrong schema, after which every runner guarantee sits on sand and a future migration fails non-deterministically in the field (`repair_required` locks the pipeline). The semantic comparator + rehearsal-on-copy + §1.3 immutability manifest bound it.

## This still needs a review round before §2+ execution
§1 is executable now. §2–5 should go through one review-loop pass (and the Uganda step a dedicated rehearsal sign-off) once #1/#87 land.
