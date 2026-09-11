# Uganda catch-up + schema baseline runbook (issue #87, refactor item 2.1)

> ## ⚠ SCHEMA WORK REHEARSED GREEN — THREE GATES STILL OPEN
>
> The schema catch-up + rebuild + migrate-to-head pipeline (G4) is rehearsed
> end-to-end on a byte-copy of the real Uganda database and reaches head
> cleanly (`docs/operations/uganda-schema-rebuild-20260911-report.md` §6, §12).
> That is the hard part this runbook exists to de-risk, and it is done.
>
> Three gates are not evidenced yet and must close before anyone runs this on
> the real gateway:
> 1. **The `Kaweza` user must exist again on `server.opensmartirrigation.org`.**
>    That test server's database was reset; Uganda's outbox backlog cannot
>    land anywhere until the account is recreated there.
> 2. **A confirmed good-connectivity window** for the on-device run (§Phase 0).
> 3. **Phil's explicit go-ahead to execute against the real gateway.**
>
> **This document is the plan of record for that window; it is not
> authorization to run it.** Uganda is the one gateway in the fleet without a
> cloud mirror of its own history (see "Why Uganda is special" below). Do not
> run Phase 3/4 against the real device until all three items above are
> closed.

**Status:** Runbook — schema rehearsal (G4) GREEN; execution blocked on the
three gates above. Implements
[`docs/superpowers/plans/2026-07-05-option-b-boot-path-cutover.md`](../superpowers/plans/2026-07-05-option-b-boot-path-cutover.md)
§5 as an operator checklist, using the artifacts, generators, and window
script produced by
[`docs/operations/uganda-catchup-rehearsal-20260911-report.md`](uganda-catchup-rehearsal-20260911-report.md)
(additive catch-up artifact) and
[`docs/operations/uganda-schema-rebuild-20260911-report.md`](uganda-schema-rebuild-20260911-report.md)
(table-rebuild artifact, adversarial review, full end-to-end proof).
**Scope:** ONE rehearsed window that combines Uganda's schema catch-up (it
predates the migration ledger and is missing whole sync tables) + table
rebuild (17 non-additive drift diffs) + baseline + migrate-to-head, not four
separate touches.
**Domain law:** `.claude/skills/osi-live-ops-runbook/SKILL.md` (how to safely
touch a live gateway), `.claude/skills/osi-schema-change-control/SKILL.md`,
AGENTS.md live-deploy safety rules.

## Precondition: network migrations 0054–0056 (PR #213) must be on main first

`database/migrations/ordered/` currently ends at `0053__installation_identity_backfill.sql`
(head=53). PR #213 adds migrations `0054`–`0056` for the network-planning /
edge-observation-history work
([`docs/superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md`](../superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md)
is a sibling piece of this same week's work, not that PR itself). `migrate-cli.js`
carries Uganda straight to whatever head is on `main` at run time. Run this
window **after** PR #213 merges, so Uganda reaches head once instead of
needing a second migrate-cli pass over the same flaky Tailscale link a few
weeks later. If PR #213 has not merged when the other three gates close, wait
for it; do not split the window.

## HARD GATES (all must be TRUE before this runbook may run)

| # | Gate | Status | Evidence |
|---|---|---|---|
| G1 | The cloud host Uganda's outbox will replay against is reachable and has an account for Uganda's operator. | **OPEN.** | Uganda syncs to `server.opensmartirrigation.org` (test host), user `Kaweza`. That host's database was reset; `Kaweza` does not currently exist there. Recreate the user before Phase 5, since backlog replay begins the moment `sync_link_state.linked=1`, and a replay against a host with no matching account fails every event, not just the first one. |
| G2 | Stage-1 deploy runner (`migrate-cli.js` + `baseline-existing-db.js`) proven on a real gateway, not just fixtures. | **Satisfied for the runner mechanics.** | kaba100 main deploy 2026-09-11, payload `20260911T071921Z`, migrations 31→53 applied live. Uganda's own rehearsal (G4 below) additionally proves the runner against a byte-copy of Uganda's actual, far-more-drifted schema, a harder case than kaba100's. |
| G3 | Heartbeats (issue #100) arriving from Uganda with `schema_sig` present. | **Satisfied (done since issue #100).** | Uganda has no `sync_outbox`-based telemetry path independent of this (see G1), so the heartbeat stays the only remote window onto the migration result during and after the window. |
| G4 | Schema catch-up + rebuild + migrate-to-head rehearsed GREEN on a byte-copy of Uganda's CURRENT database. | **GREEN.** | sha256 `0f131395c6dfb02d16ea770c7ab20e4b23615c6ea3311c9e1802b398abee4460` (compressed), decompressed copy sha256 `04b75d9688c093ebf3bbab52765d72a1ad21938bc94c06f763b0cf14ecb2136d`. Full pipeline reaches `baseline` N=1 and `migrate-cli` head=53 with `verify-head-cli.js` returning `{"ok":true}`, `PRAGMA integrity_check` `ok`, `PRAGMA foreign_key_check` 0 rows, every history-bearing row count identical before/after (`uganda-schema-rebuild-20260911-report.md` §6, §12). Re-run after the adversarial-review fixes (PR #211) with fresh timings: rebuild artifact 5.9 s, baseline scan 6m25s, migrate-cli 2m28s, full on-device window script 9m2s end-to-end, exit 0. |
| G5 | Connectivity window confirmed; on-device disk headroom checked. | **Disk headroom satisfied; connectivity window OPEN.** | Disk: the design doc's worst case is about 108 MB (2x the 54 MB DB) against Uganda's 3.3 GB free, more than 30x margin, and the window script's own preflight (`uganda-catchup-window.sh`, added in the PR #211 review) hard-refuses before stopping Node-RED unless free space is at least 3x current DB size + 64 MB, so the check runs live regardless of this table. Connectivity: no window confirmed yet; this is one of the three gates in the banner above. |

If any gate above reads OPEN, STOP. Do not proceed to Phase 3/4. The two
gates that are genuinely still open (G1's `Kaweza` user, G5's connectivity
window) plus Phil's go-ahead are the three items in the banner.

## Accepted residual: `applyBootstrap` single-transaction hazard (Fable review 2026-07-10)

**1.B4 hardens the events path (`applyEventsV2`) but explicitly scopes out `applyBootstrap` (1.B4 spec Non-goals).** `applyBootstrap` (`:98`) wraps all bootstrap collections in a single `@Transactional`, the same poison-batch semantics 1.B4 fixes for events. Uganda's catch-up window leads with **bootstraps** (the edge POSTs a full bootstrap every 6 hours and on every Force Sync), not outbox replay, once `sync_link_state.linked=1`.

**Mitigations that keep this from being critical:**
- Bootstrap payloads are LIMIT-bounded (500/500/500/365/365/365/200 per collection, verified in the `Build Cloud Bootstrap` inject node) and upsert-idempotent.
- The failure mode is a wedged, endlessly-retried ~2-3k-row transaction on the host: visible (server logs), bounded (finite payload), and transient (the next bootstrap cycle retries the whole thing).
- This is NOT the dedup-row-loss class 1.B4 fixes (bootstraps don't go through the inbox/watermark path).

**Monitoring during the window:** after Uganda deploys and starts bootstrapping:
1. Watch `server.opensmartirrigation.org`'s backend logs for repeated `applyBootstrap` failures (`docker logs osi-backend 2>&1 | grep -i bootstrap`).
2. If a bootstrap batch fails repeatedly, manually apply the collections piecemeal (the bootstrap endpoint accepts partial payloads) or temporarily increase Postgres `statement_timeout`.
3. The window is complete when `sync_link_state.linked=1` on Uganda AND at least one bootstrap cycle completes without error on the server.

**Future hardening (not a gate for 2.1):** per-collection transactions in `applyBootstrap` would close this residual for all gateways. Filed for the next sync-hardening round, not blocking Uganda.

## Why Uganda is special (the facts that make this a one-window operation)

- **Uganda predates the migration ledger by more than the missing-tables framing suggested.** The 2026-09-11 rehearsal found `sync_outbox` itself IS present on Uganda; the earlier assumption that it was entirely absent was stale (see "Runbook history" below). It was only missing its 3 v2 columns (`rejected_at`, `rejection_reason`, `last_retryable_failure_at`). 6 whole tables are genuinely missing: `sync_link_state`, `sync_history_cursors`, `sync_history_dirty_keys`, `sync_history_segments`, `sync_history_quarantine`, `history_channel_rollups`. On top of that, 6 further tables that DO exist (`devices`, `device_data`, `irrigation_events`, `valve_actuation_expectations`, `zone_irrigation_calibration`, `zone_weather_cache`) have diverged from every point on the migration timeline: years of ad-hoc, pre-ledger DDL, not something any migration ever produced. Both problems needed their own artifact (see below).
- **No cloud backup of Uganda's history until this window runs.** Every other gateway mirrors to the cloud via `sync_outbox`; Uganda's outbox has been accumulating locally (15,732 rows as of the 2026-09-10 byte-copy) with nowhere to deliver to until `sync_link_state` exists and the account on the receiving host is live. The byte-copy taken in Phase 1 is the only backup until then.
- **Production farm.** `Kaweza`, `osi-uganda-01.tail77bd41.ts.net` / `100.69.51.98`, EUI `0016C001F151B1D6`. Irreplaceable irrigation + sensor history.

## The catch-up + rebuild artifacts (authored, rehearsed, and reviewed within this runbook's scope)

Two generated, non-hand-edited SQL artifacts run back-to-back, plus one existing repair script:

1. **Additive catch-up artifact**: `scripts/ops/uganda-catchup-20260911.sql`, generated by `scripts/ops/generate-uganda-catchup-20260911.js`. `CREATE TABLE/INDEX IF NOT EXISTS` for the 6 missing tables plus 12 of 13 missing indexes (the 13th, `idx_irrigation_events_event_uuid`, is deliberately excluded, since its column doesn't exist yet and `CREATE INDEX` on a nonexistent column fails at creation time) plus all 28 missing/changed triggers. Every object is sourced **verbatim from `database/migrations/ordered/0001__baseline.sql`** (reference(1)), NOT `database/seed-blank.sql`, which tracks HEAD and would recreate objects in their post-migration shape, permanently defeating the clean N=1 baseline match this artifact exists to enable (see "Runbook history" item 2). `--apply`, `--verify` (checks presence, not full baseline match), unit tests in `scripts/ops/generate-uganda-catchup-20260911.test.js` (3/3 pass; run directly, not via `node --test`, which mis-reports the suite wrapper; see the rehearsal report for that quirk).
2. **`scripts/repair-sync-outbox-v2.js`**: unmodified, sanctioned pre-ledger repair tool. Adds the 3 missing `sync_outbox` v2 columns. A no-op if they're already present.
3. **Table-rebuild artifact**: `scripts/ops/uganda-schema-rebuild-20260911.sql`, generated by `scripts/ops/generate-uganda-schema-rebuild-20260911.js`. Rebuilds `devices` and `device_data` (in that order, in one transaction, under `PRAGMA foreign_keys=OFF` + `PRAGMA legacy_alter_table=ON` held for the whole transaction, because `devices` has 5 FK-cascade children and dropping it with FK enforcement on would cascade-delete 69,686 `device_data` rows as a side effect of fixing a CHECK constraint), `ALTER TABLE ADD COLUMN` on `irrigation_events` for `event_uuid`, and rebuilds `valve_actuation_expectations`, `zone_irrigation_calibration`, `zone_weather_cache`. Every per-table preflight (orphan counts, NULL counts, a `zone_weather_cache.updated_at <> created_at` drift guard) refuses BEFORE any DDL runs if the live data doesn't match what the design doc's audit found; full column mapping and rationale in `docs/superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md`. `--dry-run`, `--verify`, `--apply`; idempotent (a second `--apply` on an already-rebuilt table logs `already canonical, skipping`; the `irrigation_events` idempotency bug this depends on was found and fixed in the PR #211 adversarial review, not by hand-inspection).

All three steps are additive-or-guarded: no unconditional `DROP`, no unguarded `ALTER`, no data deletion. Both generated artifacts are produced from `database/migrations/ordered/0001__baseline.sql`, never hand-retyped, so the objects they create are byte-identical to the reference and the baseline gate that follows passes.

## The window — operator procedure

> Run each phase only after the prior phase's expected output is confirmed. Every
> destructive-adjacent step keeps a backup **on-device AND off-device**. Use ONE
> connection-drop-immune `setsid` script for the on-device run — never stream
> statements over the intermittent link.

### Phase 0 — Prereqs confirmed

- [ ] PR #213 (network migrations 0054–0056) merged to `main` (see precondition above).
- [ ] G1 (`Kaweza` user exists on `server.opensmartirrigation.org`), G5's connectivity window, and Phil's go-ahead are all confirmed (the three banner items). G2–G4 are already evidenced above.
- [ ] `ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@osi-uganda-01.tail77bd41.ts.net` reachable; `df -Pk /data` shows room for a second DB copy (the on-device script's own preflight re-checks this before stopping Node-RED, but confirm by eye first).
- [ ] Current flows deployed to Uganda AND Node-RED restarted, so the boot node converged the current trigger set before baselining starts. If not, do a flows-only deploy + restart first and let it settle.

### Phase 1 — Exfiltrate a byte-copy (the only backup until Phase 5 links Uganda to its cloud host)

- [ ] On-device: `sqlite3 /data/db/farming.db ".backup '/data/db/farming.db.catchup-$(date -u +%Y%m%dT%H%M%SZ)'"` (the CLI must be present — `opkg install sqlite3-cli` if absent, as `deploy.sh` already does).
- [ ] `sqlite3 <backup> 'PRAGMA integrity_check;'` → must print `ok`.
- [ ] `gzip` the backup. The Pis have no `sftp-server`, so plain `scp` fails; stream it off-device instead: `ssh root@<pi> 'cat /data/db/farming.db.catchup-<ts>.gz' > farming.db.catchup-<ts>.gz` (same reason `deploy-push-bundle.sh` uses a `cat` pipe rather than `scp`; see `docs/operations/deploying-over-a-flaky-link.md`). Verify sha256 both ends. Keep it for N days.
- Precedent from the 2026-09-10 exfiltration: compressed sha256 `0f131395c6dfb02d16ea770c7ab20e4b23615c6ea3311c9e1802b398abee4460`, kept off-device at `~/osi-backups/` and on-device at `/data/db/farming.db.catchup-20260910T225932Z.gz`. This window takes a fresh one; the 2026-09-10 copy is what was rehearsed, not a substitute for a current backup.

### Phase 2 — Rehearse the EXACT artifact pipeline on the fresh copy (already done once on the 2026-09-10 copy; repeat on this window's fresh copy)

On the exfiltrated copy (never the live file):
- [ ] `node scripts/baseline-existing-db.js <copy> --report` → confirm the failing-diff count and shape match what's documented in `uganda-catchup-rehearsal-20260911-report.md` and `uganda-schema-rebuild-20260911-report.md`. A different shape means Uganda's schema has drifted further since 2026-09-10; stop and re-audit before continuing.
- [ ] Apply the additive catch-up artifact (`node scripts/ops/generate-uganda-catchup-20260911.js --apply <copy>`), then `node scripts/repair-sync-outbox-v2.js <copy>`, then the table-rebuild artifact (`node scripts/ops/generate-uganda-schema-rebuild-20260911.js --apply <copy>`). This order matches the on-device script (§Phase 3), not the original rehearsal's exploratory order.
- [ ] `node scripts/baseline-existing-db.js <copy>` → expect `stamped versions 1..1`.
- [ ] `node scripts/migrate-cli.js <copy> --backup-dir <scratch>` → off-device backup taken + fsync'd; applies pending migrations to head; `node scripts/verify-head-cli.js <copy>` → `{"ok":true}`.
- [ ] Postflight: `PRAGMA integrity_check` = `ok`, `PRAGMA foreign_key_check` = zero rows.
- [ ] Row-count invariants — before-pipeline vs after-migrate-to-head, identical on every history-bearing table. The 6 tables created by the catch-up artifact start empty (or with the one `sync_link_state` bootstrap row); that is expected and is the only allowed count delta.
- [ ] Restore-path mechanics are already proven (fixture-based, not Uganda-specific — `uganda-catchup-rehearsal-20260911-report.md` "Restore-path + migrate-cli mechanics"); no need to re-rehearse the byte-image restore itself unless `lib/osi-migrate` changes.
- [ ] Boot-DDL fallback verifiers (no headless-Node-RED harness exists in this repo, so these stand in for booting Node-RED against the migrated copy): `node scripts/verify-sync-flow.js`, `node scripts/verify-boot-ddl-interpolation.js`, `node scripts/verify-runtime-schema-parity.js`. All three OK.
- [ ] **Any rehearsal failure HOLDS the window. Full stop.** Fix on the copy, re-rehearse, only then proceed.

### Phase 3 — Assemble the ONE on-device script

- [ ] `scripts/ops/uganda-catchup-window.sh` is the assembled script, POSIX/BusyBox-ash only, styled on `deploy.sh`'s `run_schema_migration()`. It runs, in order: disk-space preflight (`df -Pk`; refuses BEFORE Node-RED is stopped if free space < 3x current DB size + 64 MB) → `/etc/init.d/node-red stop` (waits up to 30s, verified stopped) → pre-window row-count snapshot → on-device `.backup` + `integrity_check` (kept on-device AND already off-device from Phase 1) → apply the catch-up artifact → apply the table-rebuild artifact (its own preflights: drift-signature match, per-table orphan/NULL/drift guards; `rc=1` means REFUSE-AND-HOLD, DB provably untouched, do not restore a backup, there is nothing to undo; `rc=2` means REBUILD-CRASHED, restore the on-device backup taken above before retrying) → post-rebuild `integrity_check` + `foreign_key_check` → `repair-sync-outbox-v2.js` → `baseline-existing-db.js` → `migrate-cli.js --backup-dir <on-device scratch>` → postflight (`integrity_check`, `foreign_key_check`, `verify-head-cli.js`, row-count invariants against the pre-window snapshot) → `/etc/init.d/node-red start` on every exit path via an `EXIT`/`INT`/`TERM` trap, including failure. Exit 0 means full success; exit 1 means any failure or refusal (Node-RED restarted regardless by the trap); exit 2 means a usage error before anything touched the DB.
- [ ] Upload the script and the payload directory it expects: both generated artifacts, `repair-sync-outbox-v2.js`, `baseline-existing-db.js`, `migrate-cli.js`, `verify-head-cli.js`, `semantic-schema-compare.js`, the `lib/osi-migrate/*.js` runner modules, and `database/migrations/ordered/` (`CHECKSUMS.json` plus every `00NN__*.sql`). The exact list is in the script's own header comment. Stream it on rather than `scp` (no `sftp-server` on the Pis; see Phase 1).

### Phase 4 — Run it on-device (connection-drop-immune)

- [ ] Launch under `setsid sh /data/db/uganda-catchup-window.sh /data/osi-catchup-payload > /data/db/catchup-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 &` then `disown`. Reconnect and `tail -f` the log if the SSH session drops.
- [ ] Confirm the log ends with `FINAL: OK: ...`, `verify-head` `{"ok":true}`, row-count invariants all `ok`, and Node-RED restarted.

### Phase 5 — Verify remotely

- [ ] Heartbeat `schema_sig` = head value; `error_counts.total` flat.
- [ ] `sync_link_state.linked` flips to 1 and bootstrap/backlog delivery begins against `server.opensmartirrigation.org`. Watch that host's dead-letter table stays empty and no batch rollback-loops (the accepted-residual `applyBootstrap` monitoring above).
- [ ] Keep all backups (on- and off-device) N days per `osi-live-ops-runbook`.

### Post-window note: no manual restamp needed on the next deploy

Uganda's `0001__baseline.sql`-sourced trigger bodies carry a hardcoded
fallback gateway EUI literal that is Silvan's, not Uganda's
(`COALESCE(NEW.gateway_device_eui, '0016C001F11715E2')`). `sync-init-fn`
rewrites it to the real `DEVICE_EUI` on every Node-RED start, so it is
transient. On prior gateways, though, that transient rewrite showed up as a
`schema_object_fingerprints` drift that needed a manual
`node scripts/restamp-fingerprints.js` to clear (see
`osi-live-ops-runbook` "Stale-fingerprint recovery").

PR #214 (`fix/runner-drift-grace-path`, merged 2026-09-11) removed that
manual step going forward. `lib/osi-migrate/runner.js` now tolerates a
boot-owned trigger's body diff automatically, provided the raw body is equal
to the reference's raw body after `fingerprints.js`'s `normalizeSqlV3`
(gateway-EUI canonicalization + SQL-formatting normalization). Anything the
normalizer doesn't explain away still refuses, so a genuine hand-edited drift
is still caught. Uganda's next ordinary deploy after this window will hit
exactly this boot-rewrite case and should NOT need
`restamp-fingerprints.js` run by hand. If it still reports drift, that is a
signal to investigate before restamping, not to restamp reflexively.

## Post-run evidence (fill after a real execution — this is what closes item 2.1)

- Execution date/operator: __________
- Matched baseline N: __________
- Migrations applied by `migrate-cli`: __________
- Row-count invariants: __________ (must be IDENTICAL except the newly-empty sync tables)
- Heartbeat `schema_sig` before → after: __________
- `Kaweza` user recreated on `server.opensmartirrigation.org`, date: __________
- Cloud dead-letter count during backlog replay: __________ (expect 0)
- Backups retained (paths, expiry): __________
- Surprises / findings: __________

## Runbook history

Corrections applied 2026-09-11 after the additive catch-up rehearsal
(`uganda-catchup-rehearsal-20260911-report.md`) and the table-rebuild
rehearsal (`uganda-schema-rebuild-20260911-report.md`):

1. **"Uganda has no `sync_outbox`" was stale.** `sync_outbox` is present with
   15,732 rows as of the 2026-09-10 byte-copy; it was only missing 3 v2
   columns, which `repair-sync-outbox-v2.js`, already designed for exactly
   this, handles cleanly.
2. **Sourcing the catch-up artifact from `seed-blank.sql` (HEAD) would have
   silently broken the baseline gate.** `sync_link_state` gained an
   `installation_uuid` column and 16 of the 28 target triggers were edited by
   migrations `0015`–`0053` between `0001` and HEAD. Every object is now
   sourced from `database/migrations/ordered/0001__baseline.sql` instead;
   `migrate-cli.js`'s ordinary `applyPending` carries each object forward to
   HEAD shape exactly as it would for any other gateway baselined at N=1.
3. **"Missing whole sync tables" undersold the gap.** 17 further diffs on 6
   tables that already exist (FK declarations, CHECK constraint scope, column
   defaults/nullability) predate even reference(1) and needed a dedicated
   table-rebuild artifact, not `CREATE ... IF NOT EXISTS`. Closed by the
   design in `docs/superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md`
   and the generator in `scripts/ops/generate-uganda-schema-rebuild-20260911.js`.
4. **G4 is now demonstrated GREEN**, including the adversarial-review fixes
   in PR #211: an `irrigation_events` idempotency bug that crashed on a
   second `--apply`, a disk-space preflight, and two documented deviations
   from SQLite's literal 12-step `ALTER TABLE` procedure (both `PRAGMA
   foreign_key_check` and `PRAGMA foreign_keys = ON` run post-`COMMIT` rather
   than pre-`COMMIT`, because `lib/osi-migrate`'s CLI runner has no persistent
   session across statements). Full rationale in
   `uganda-schema-rebuild-20260911-report.md` §11-12.

## Non-goals / boundaries

- This runbook does **not** remove boot-node DDL (Stage 2 / item 4.3) — Uganda keeps its boot node.
- It does **not** author ordered migrations for Uganda's pre-ledger schema (both artifacts are consumed-or-deleted after baseline, not part of `database/migrations/ordered/`).
- It does **not** run before the three banner gates close, regardless of how green G2–G4 already are.
