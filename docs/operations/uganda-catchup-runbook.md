# Uganda Catch-up + Schema Baseline Runbook (issue #87, refactor item 2.1)

> ## ⛔ NOT READY — DO NOT EXECUTE
>
> This runbook is **gated NOT-READY** until every HARD GATE below is satisfied and
> the **evidence rows at the end are filled with real, dated output**. Uganda is the
> one irreplaceable production DB in the fleet (`Kaweza` farm; no `sync_outbox`
> cloud backup — see §Why Uganda is special). Running any step against the live
> gateway before the gates pass risks unrecoverable farm-history loss.
>
> **This document is the plan of record for that window; it is not authorization to run it.**

**Status:** Runbook — NOT READY. Implements [`docs/superpowers/plans/2026-07-05-option-b-boot-path-cutover.md`](../superpowers/plans/2026-07-05-option-b-boot-path-cutover.md) §5 as an operator checklist. Consumes the Stage 0 tooling ([`2026-07-07-option-b-stage0-canonicalization-design.md`](../superpowers/specs/2026-07-07-option-b-stage0-canonicalization-design.md)) and the Stage 1 deploy runner ([`2026-07-08-option-b-stage1-deploy-runner-design.md`](../superpowers/specs/2026-07-08-option-b-stage1-deploy-runner-design.md)).
**Scope:** ONE rehearsed window that combines Uganda's schema **catch-up** (it is missing whole sync tables) + **baseline** + **Stage-1 migration** — not three separate touches.
**Domain law:** `.claude/skills/osi-live-ops-runbook/SKILL.md` (how to safely touch a live gateway), `.claude/skills/osi-schema-change-control/SKILL.md`, AGENTS.md live-deploy safety rules.

## HARD GATES (all must be TRUE before this runbook may run)

| # | Gate | Why | Evidence (fill before executing) |
|---|---|---|---|
| G1 | **osi-server 1.B4 (per-event tx + dead-letter, DD13) MERGED and DEPLOYED** to the cloud host Uganda syncs to. | A weeks-stale gateway replaying its backlog is the exact poison-pill trigger: the current whole-batch `@Transactional` fails the batch repeatedly, losing dedup rows (refactor-program ground-truth #6). Running Uganda's catch-up before 1.B4 converts a schema catch-up into a cloud outage. This is the program's named one-way-door risk. | ☐ PR link + deploy date: __________ |
| G2 | **1.B1 (Stage 1 deploy runner) PROVEN on BOTH demo gateways** (kaba100 + Silvan): live deploy done, `schema_sig` = head, `0004` CHECK widened, row-count invariants held, sustained healthy heartbeats. | Uganda must never be the first real gateway the runner + backup/restore path touches. Demos are rebuildable; Uganda is not. | ☐ kaba100 date + evidence: ______ ☐ Silvan date + evidence: ______ |
| G3 | **Heartbeat (issue #100, done) live on Uganda** — fresh `0.6.x` heartbeats arriving with the `schema_sig` field present. (The plan §5 text says "#1"; the adopted program names the heartbeat as **#100 (done)** — the substance is unchanged: heartbeats actually arriving from Uganda.) | Uganda has no `sync_outbox` → no cloud sync telemetry → the heartbeat is the ONLY remote window to verify the migration result. Without it, a bad outcome is invisible until the next physical visit. | ☐ last heartbeat ts + `schema_sig`: ______ |
| G4 | **Fresh byte-copy rehearsal GREEN** — the identical catch-up+baseline+migrate artifact ran clean on an exact byte-copy of Uganda's CURRENT DB, taken in this window. | The one non-negotiable (plan §5): no artifact runs on the device until it ran green on a real copy of that device's DB. Rehearsal-on-real-copy is the entire safety story. | ☐ copy sha256 + rehearsal date + result: ______ |
| G5 | **A good-connectivity window is confirmed** for the exfiltration + on-device run, and Uganda disk has room for a second full DB copy (`df` checked). | The byte-copy exfiltration and the on-device backup both need headroom; an intermittent link mid-run is why step 4 uses a connection-drop-immune `setsid` script. | ☐ disk free: ______ ☐ window: ______ |

If any gate is ☐, STOP. Do not proceed. Filling these rows with real evidence is what flips this runbook from NOT-READY to READY.

## Why Uganda is special (the facts that make this a one-window operation)

- **Uganda is missing whole sync tables.** Unlike kaba100/Silvan, Uganda's DB has **no `sync_outbox` and no `sync_link_state`** (plan Decision paragraph: "Uganda additionally has no `sync_outbox` at all (zero cloud backup)"). Stage 0's `repair-sync-outbox-v2.js` explicitly refuses a DB whose `sync_outbox` is absent entirely (that is this #87 whole-table gap, Stage 0 §D(d) — out of Stage 0's scope, in this runbook's scope). So Uganda needs an **additive catch-up artifact that CREATEs the missing tables + triggers first**, before the standard baseline path can run.
- **No cloud backup of Uganda's history.** Every other gateway mirrors to the cloud via `sync_outbox`; Uganda does not, so the byte-copy taken in this window is the ONLY backup. Treat it accordingly.
- **Production farm.** `Kaweza`, `osi-uganda-01.tail77bd41.ts.net` / `100.69.51.98`, EUI `0016C001F151B1D6`. Irreplaceable irrigation + sensor history.

## The catch-up artifact (authored + rehearsed within this runbook's scope)

An **idempotent, additive** artifact that brings Uganda's DB up to the shape the Stage 0 baseline expects. Authored here (NOT an ordered migration — the missing tables predate the ledger the same way the `sync_outbox` v2 columns do; Stage 0 §D(c)/(d) rationale applies), and rehearsed on the byte-copy before the device run:

1. `CREATE TABLE IF NOT EXISTS sync_outbox (…)` — **byte-identical to `database/seed-blank.sql`'s `sync_outbox` DDL** (all v2 columns included: `rejected_at`, `rejection_reason`, `last_retryable_failure_at` — so `repair-sync-outbox-v2.js` is a clean no-op afterward), plus `CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(delivered_at, occurred_at)`.
2. `CREATE TABLE IF NOT EXISTS sync_link_state (…)` — byte-identical to the seed's DDL, plus the seed's `INSERT … SELECT … FROM users … ON CONFLICT(peer_node) DO UPDATE SET …` bootstrap for `peer_node='cloud'` (verified: the seed guards idempotency with `ON CONFLICT DO UPDATE`, not `WHERE NOT EXISTS`; a re-run updates the existing row rather than duplicating). Copy it byte-identically from `seed-blank.sql`.
3. The **outbox + sync-dirty triggers** that write `sync_outbox` — each `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`, copied from the seed's current bodies (the same convergence `sync-init-fn` does on boot; do NOT hand-edit trigger logic). The seed defines **31 triggers total**; `sync-init-fn` converges **30** of them on boot (17 are the `INSERT INTO sync_outbox` outbox triggers, the rest are sync-dirty/other). The artifact must recreate every trigger the comparator reports `missing` on Uganda — do NOT rely on a hardcoded count; the `--report` diff (Phase 2) is the authoritative list of what Uganda lacks. These only fire once `sync_link_state.linked=1`, so creating them is safe.
4. Any other seed table absent on Uganda that the comparator would flag `missing` — determined empirically by running `baseline-existing-db.js --report` on the byte-copy FIRST and reading its `missing` diffs (do not guess the full set; the report is the source of truth for what Uganda lacks).

The artifact is **additive only** (`IF NOT EXISTS` / guarded inserts); it creates nothing destructive. It must be **generated from `seed-blank.sql`, never hand-retyped** (the same discipline as the ordered-migration seed blocks), so the created objects are semantically identical to the reference and the subsequent baseline gate passes.

## The window — operator procedure (plan §5, verbatim as a checklist)

> Run each phase only after the prior phase's expected output is confirmed. Every
> destructive-adjacent step keeps a backup **on-device AND off-device**. Use ONE
> connection-drop-immune `setsid` script for the on-device run — never stream
> statements over the intermittent link.

### Phase 0 — Prereqs confirmed
- [ ] All HARD GATES G1–G5 green (evidence rows filled above).
- [ ] `ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@osi-uganda-01.tail77bd41.ts.net` reachable; `df -h /data` shows room for a second DB copy.
- [ ] The current flows have been deployed to Uganda AND Node-RED restarted (item 0.1) so the boot node converged the current trigger set — the §D baselining precondition (Stage 0 §B / Stage 1 §D). If not, do a flows-only deploy + restart first and let it settle.

### Phase 1 — Exfiltrate a byte-copy (the only backup)
- [ ] On-device: `sqlite3 /data/db/farming.db ".backup '/data/db/farming.db.catchup-$(date -u +%Y%m%dT%H%M%SZ)'"` (the CLI must be present — Stage 1 §B; install `sqlite3-cli` via `opkg` if absent, as in the Stage-1 deploy).
- [ ] `sqlite3 <backup> 'PRAGMA integrity_check;'` → must print `ok`.
- [ ] `gzip` the backup, `scp` it off-device to the workstation, verify sha256 both ends. Keep it for N days (backups retained per `osi-live-ops-runbook`).

### Phase 2 — Rehearse the EXACT artifact locally on the copy (G4)
On the exfiltrated copy (never the live file):
- [ ] `baseline-existing-db.js <copy> --report` → read the `missing` diffs; confirm they are exactly `sync_outbox`, `sync_link_state`, their index/triggers (+ any table Phase-4-of-the-artifact must add). Record the report.
- [ ] Apply the additive **catch-up artifact** → then `repair-sync-outbox-v2.js <copy>` (now a no-op, since the artifact created `sync_outbox` with v2 columns) → then `baseline-existing-db.js <copy>` (head-down; record the matched N).
- [ ] `migrate-cli.js <copy> --backup-dir <scratch> --migrations-dir <fetched ordered dir>` → off-device backup taken + fsync'd; `applyPending` applies the pending set; `verifyHead` = `{ok:true}`.
- [ ] **Restore-path rehearsal** (Stage 1 Rehearsal DoD step 3): on a SECOND copy, inject a failing migration and prove `migrate-cli.js` restores the byte-image + exits non-zero.
- [ ] Postflight: `PRAGMA integrity_check` = `ok`, `PRAGMA foreign_key_check` = zero rows.
- [ ] **Row-count invariants** — before-artifact vs after-migrate-to-head, identical on every history-bearing table (`device_data`, `chameleon_readings`, `dendrometer_readings`, `dendrometer_daily`, `irrigation_events`, `zone_daily_environment`, `zone_daily_recommendations`, `analysis_views`, `irrigation_schedules` — the headline). Newly-created `sync_outbox`/`sync_link_state` start empty; that is expected and is the ONLY allowed count delta.
- [ ] Boot a throwaway Node-RED against the migrated copy — no schema-related errors.
- [ ] **Any rehearsal failure HOLDS the window. Full stop.** Fix on the copy, re-rehearse, only then proceed.

### Phase 3 — Assemble the ONE on-device script
- [ ] Bundle the identical artifact + tools into a single script that runs **entirely on-device under `setsid`, logging to a file**, never streaming statements over the link. It must, in order: `/etc/init.d/node-red stop` (verify stopped) → `.backup` + `integrity_check` (kept on-device AND already off-device from Phase 1) → apply the catch-up artifact → `repair-sync-outbox-v2.js` → `baseline-existing-db.js` → `migrate-cli.js … --backup-dir <on-device scratch>` → postflight (`integrity_check`, `foreign_key_check`, `verifyHead ok`, row-count invariants) → `/etc/init.d/node-red start` **on every exit path (trap)**. On any failure, `migrate-cli.js`'s restore + the deploy trap restart Node-RED (against the restored DB only if integrity-verified — Stage 1 §E rc=3 semantics).
- [ ] Upload the script + the fetched ordered-migrations dir + `CHECKSUMS.json` + the three Stage-0/Stage-1 tool scripts to the device.

### Phase 4 — Run it on-device (connection-drop-immune)
- [ ] Launch under `setsid … > /data/db/catchup.log 2>&1 &`; disconnect-safe. Reconnect and `tail` the log.
- [ ] Confirm the log ends with postflight all-green, `verifyHead ok`, row-count invariants IDENTICAL, and Node-RED restarted.

### Phase 5 — Verify remotely
- [ ] Heartbeat `schema_sig` = head value; `error_counts.total` flat (heartbeat is the remote proxy for `verifyHead ok`).
- [ ] `sync_link_state.linked` / resumed sync telemetry — Uganda now has a `sync_outbox`, so (with 1.B4 deployed) backlog delivery begins; watch the cloud dead-letter table stays empty and the batch does not rollback-loop (the G1 poison-pill guard doing its job).
- [ ] Keep all backups (on- and off-device) N days.

## Post-run evidence (fill after a real execution — this is what closes item 2.1)

- Execution date/operator: __________
- Matched baseline N: __________
- Migrations applied by `migrate-cli`: __________
- Row-count invariants: __________ (must be IDENTICAL except the newly-empty sync tables)
- Heartbeat `schema_sig` before → after: __________
- Cloud dead-letter count during backlog replay: __________ (expect 0)
- Backups retained (paths, expiry): __________
- Surprises / findings: __________

## Non-goals / boundaries

- This runbook does **not** remove boot-node DDL (Stage 2 / item 4.3) — Uganda keeps its boot node.
- It does **not** author ordered migrations for Uganda's missing tables (they predate the ledger; the additive catch-up artifact handles them, consumed-or-deleted after baseline).
- It does **not** run before G1–G5. The NOT-READY banner stays until the evidence rows are real.
