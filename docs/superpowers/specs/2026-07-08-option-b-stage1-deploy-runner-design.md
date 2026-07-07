# Option B Stage 1 — Deploy-Time Migration Runner Invocation

**Status:** Spec — refactor-program item **1.B1**, issue #88 (Stage 1). Depends on: Stage 0 (`2026-07-07-option-b-stage0-canonicalization-design.md`, its tools consumed verbatim) and item 0.3's `baseline-existing-db.js`; gated behind the 0.2 heartbeat canary gate for post-verify.
**Scope:** osi-os edge only — `deploy.sh` gains a runner-invocation step and a new `scripts/migrate-cli.js` entrypoint; the `ensure_*` schema functions + `scripts/repair-pi-schema.js` are retired. **No boot-node change** (`sync-init-fn` stays FROZEN — that is Stage 2 / item 4.3). **No Uganda execution** (item 2.1's window; Uganda is EXCLUDED from this rollout).
**Governs:** [`docs/superpowers/plans/2026-07-05-option-b-boot-path-cutover.md`](../plans/2026-07-05-option-b-boot-path-cutover.md) §3. The reshape decisions there — deploy-time via the `sqlite3` CLI, NEVER at boot; per-device baseline gated by a semantic comparator — are SETTLED and not relitigated here.
**ADR:** [`docs/adr/2026-06-30-schema-and-contract-ownership.md`](../../adr/2026-06-30-schema-and-contract-ownership.md) — edge SQLite DDL is owned by osi-os ordered migrations + a ledger; this spec makes the ledgered runner the on-device schema authority for the first time.
**Domain law:** `.claude/skills/osi-schema-change-control/SKILL.md` (NEVER-list, risk classes, parity surfaces), DD9 in [`docs/architecture/refactor-program-2026.md`](../architecture/refactor-program-2026.md).

## Problem

The ordered-migration runner (`lib/osi-migrate`) is a real, tested engine that has **never run on a live gateway** (verified in `osi-schema-change-control` "Key fact": zero on-device callers of `applyPending`/`bootstrapFresh`/`verifyHead`). Live gateways get schema two ways today, both inadequate for destructive change:

1. `deploy.sh`'s five `ensure_*` functions (`ensure_dendro_schema`, `ensure_zone_irrigation_calibration_schema`, `ensure_analysis_views_schema`, `ensure_chameleon_schema`, `ensure_gateway_health_schema`) — idempotent `ALTER TABLE ... ADD COLUMN` / `CREATE TABLE IF NOT EXISTS` only. **Additive-only by construction** (`ensure_gateway_health_schema` hard-refuses any non-`additive` migration file, `deploy.sh:482`). They cannot rebuild a table.
2. `sync-init-fn`'s boot-time inline DDL (frozen; Stage 2 removes it).

The consequence, verified: **migration `0004` (the destructive CHECK-widening rebuild of `irrigation_schedules` that fixes farmer-facing #92) has reached zero live gateways** and has no delivery path. Ground-truth item 4 of the refactor program: "A destructive migration is merged and undeliverable." This is the ADR's own stated promotion trigger for Option B.

Stage 0 built the tooling to *baseline* a device (stamp its ledger at the version its live schema matches). Stage 1 is the delivery step: **invoke the runner at deploy time** — writers stopped, integrity preflight, byte-verified backup, restore-on-failure, ledger-recorded — so `0004` (and every future destructive/data migration) reaches the fleet under the runner's guarantees instead of the additive-only `ensure_*` path.

## Two hard, verified constraints that shape everything below

**Constraint 1 — the `sqlite3` CLI binary is not on the gateway image.** `cliRunner` (`lib/osi-migrate/runner-iface.js:22,27`) shells out via `execFileSync('sqlite3', ...)`, and `backup.js`'s online backup uses the `sqlite3` CLI `.backup` dot-command (`backup.js:42`). But `conf/full_raspberrypi_bcm27xx_bcm2712/.config:6534` has `# CONFIG_PACKAGE_sqlite3-cli is not set` (only `CONFIG_PACKAGE_libsqlite3=y`, `.config:3626`), and `deploy.sh:118` already treats `sqlite3` as optionally-absent (`if command -v sqlite3 ...`). MEMORY confirms only Silvan got the CLI, manually, on 2026-06-24; kaba100 and Uganda have no `sqlite3` binary. **Plan §3 (line 26) says "run the runner via the `sqlite3` CLI (`node <migrate-cli>`)"; DD9 (`refactor-program-2026.md:36`) names the runner's guarantees (byte-verified backup fsync'd before the first destructive statement, restore-on-failure invoked by the script) without mentioning the CLI at all. Neither flags that the CLI must first exist on-device.** This spec closes that gap: **§B provisions the `sqlite3` CLI binary as a Stage-1 prerequisite, verified present before any runner call, refused if absent.** (Corrected-DD11 pattern: plan §3 is directionally right — CLI, deploy-time — but factually incomplete; we ship what's true and flag the correction.)

**Constraint 2 — `deploy.sh` does not stop Node-RED.** The five `ensure_*` functions run near the end of `deploy.sh` (lines 643–647) against the **live** DB with Node-RED **still running** (restart is a manual post-deploy step, `deploy.sh:693`). The runner's destructive path hard-refuses unless `writersStopped: true` (`runner.js:47-49`), and racing a table rebuild against a live writer can corrupt in-flight rows (`osi-schema-change-control` NEVER-list). **So Stage 1's runner step must stop Node-RED before it runs and restart it after** — a behavior `deploy.sh` does not have today. §C owns this.

## Goal

Deliver a `deploy.sh` migration step that, for an already-provisioned gateway:
1. Ensures the `sqlite3` CLI is present on-device (prerequisite gate; refuse if it cannot be made present) (§B).
2. Stops Node-RED so writers are quiesced, and guarantees a restart on every exit path (§C).
3. On a device with **no ledger** (the whole current fleet), invokes `baseline-existing-db.js` (Stage 0's tool) to stamp the ledger at the matched version — refusing the whole step, writers-restarted, if baselining refuses (§D).
4. Invokes `applyPending` via a new thin `scripts/migrate-cli.js` entrypoint, carrying the device from the baselined version to head under the runner's existing writers-stopped/integrity-preflight/backup/postflight guarantees — with an explicit **second, off-device backup path fsync'd before the first destructive statement** and an **actually-invoked restore-on-failure** (§E).
5. Retires the `ensure_*` functions and `repair-pi-schema.js`, enumerating what replaces each (§F).
6. Restarts Node-RED, then leaves post-verify to the heartbeat `schema_sig` + 0.2 canary gate (§G).

Rollout order: **kaba100 → Silvan** (both demo/rebuildable). **Uganda EXCLUDED** — its catch-up + baseline is item 2.1's single rehearsed window (plan §5).

## A. What the runner already gives us (consumed, not rebuilt)

Verified in `runner.js` — Stage 1 does **not** modify `lib/osi-migrate`; it invokes it. Per migration, `applyPending`:
- Refuses `destructive` unless `writersStopped: true` (`runner.js:47-49`).
- For `destructive`/`data`: takes an online backup via `backupDb` **before** the DDL (`runner.js:51,57`), records its path in the ledger row.
- Fences destructive DDL with `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; …; COMMIT; PRAGMA foreign_keys=ON;` (`composeDestructiveScript`, FK toggle outside the tx).
- Runs `postflight` after every commit: `PRAGMA integrity_check` = `ok` **and** `PRAGMA foreign_key_check` = zero rows, else the migration is marked failed/`repair_required` (`runner.js:64,94-100`).
- Preflight drift check refuses to apply onto a schema that drifted out-of-band since the last stamp (`runner.js:19-25`) — which is precisely why Stage 0's baseline (stamp + `syncFingerprints`) must run first.
- Per-migration fingerprint stamping so a mid-batch failure leaves `1..k-1` consistent (`runner.js:80-85`).

**What the runner does NOT give us, and this spec adds** (the DD9 "missing pieces"):
- The **second, off-device backup** fsync'd before the first destructive statement (runner's own backup is same-filesystem, same SD card — insufficient if the SD is the failure). §E.
- **Restore-on-failure actually invoked by the deploy script** (the runner records `backup_path` and marks `repair_required`; it does not restore). §E.
- The **CLI provisioning** (§B) and **Node-RED stop/restart** (§C) the runner assumes but cannot do.

## B0. Delivering the migrations corpus on-device (prerequisite)

The runner's `loadMigrations(migrationsDir)` (`runner.js:28` → `migrations-loader.js`) needs **every** ordered `.sql` file physically present in a directory, and `baseline-existing-db.js` reads real checksums from `database/migrations/ordered/CHECKSUMS.json` (Stage 0 §E). Today `deploy.sh:471` fetches only `0002__gateway_health.sql` (for the additive `ensure_gateway_health_schema` hook). **Stage 1 must fetch the whole `database/migrations/ordered/` tree — `0001..0004` today, plus `0005` once Stage 0 lands — and `CHECKSUMS.json` — into an on-device `migrationsDir`** (e.g. `$TMP_DIR/migrations/ordered/`) before invoking either the baseline tool or `migrate-cli.js`. Both `scripts/migrate-cli.js` and `baseline-existing-db.js` are pointed at that fetched directory via `--migrations-dir`/`migrationsDir`. The fetch enumerates the files the deploy HTTP server exposes (the same reverse-tunnel `fetch` helper `deploy.sh` already uses); a missing or checksum-mismatched file is a hard refusal — `baseline-existing-db.js` already refuses if the fetched files diverge from `CHECKSUMS.json` (Stage 0 §E, `assertManifestMatchesDisk`), which is the built-in integrity check on this transfer. This delivery step is load-bearing: without the corpus on-device, neither the runner nor the baseline tool can function.

## B. `sqlite3` CLI provisioning (prerequisite gate)

The runner and backup both require the `sqlite3` binary. Before any runner call, `deploy.sh` must ensure it and refuse the migration step (not silently skip, not fall back to node-sqlite3) if it cannot:

1. If `command -v sqlite3` succeeds, proceed.
2. Else attempt `opkg update && opkg install sqlite3-cli` (the OpenWrt package that provides the `sqlite3` binary against the already-present `libsqlite3`). Network is available at deploy time by construction (deploy.sh fetches over the reverse-tunnel HTTP server).
3. Re-check `command -v sqlite3`. If still absent, **refuse the entire migration step** — print an explicit error, leave the DB untouched, do NOT restart into a partially-migrated state (there is nothing partial yet), exit non-zero. A gateway that cannot get the CLI does not get Stage 1 this deploy; it keeps running its current schema. The old `ensure_*` path is gone (§F), so the operator sees a hard, actionable failure rather than silent additive-only drift.

**Decision — provision, don't rewrite to node-sqlite3.** The alternative (a node-sqlite3 `runtimeRunner` adapter matching `cliRunner`'s contract, noted as "future" in `runner-iface.js` and `backup.js`) is a larger, riskier change: node-sqlite3's `.backup()` API and transaction semantics would need their own rehearsal, and it forks the tested CLI path the whole runner test-suite exercises. `sqlite3-cli` is a stock OpenWrt package; installing it is the smaller blast radius and keeps on-device behavior byte-identical to what CI rehearses. The node-sqlite3 adapter stays a documented future option, not a Stage-1 dependency. **The image config should also flip `CONFIG_PACKAGE_sqlite3-cli=y` in a follow-up so future flashes ship it** (filed as a follow-up, not in this slice — it needs a firmware rebuild + boot test, out of a deploy-script slice's scope); until then the deploy-time `opkg install` is the delivery path for already-flashed gateways.

## C. Node-RED stop/restart bracket

The migration step runs **after** all files are fetched and `npm install` completes (so a mid-deploy abort before this point leaves the old running system intact), and is bracketed:

1. `/etc/init.d/node-red stop` — quiesce writers. Verify it actually stopped (poll for the process to exit, bounded ~30 s; the DB's WAL busy_timeout is 5 s so a clean stop settles fast). If it will not stop, refuse the migration step and restart it (nothing was touched).
2. **WAL checkpoint + settle:** after stop, `PRAGMA wal_checkpoint(TRUNCATE)` via the CLI so the backup and integrity check see a fully-checkpointed DB, and no `-wal`/`-shm` sidecar carries uncommitted frames past the backup.
3. Run §D (baseline if needed) then §E (applyPending + backup/restore).
4. **`finally`-equivalent restart:** `/etc/init.d/node-red start` runs on **every** exit path — success, baseline refusal, migration failure-after-restore — implemented in shell as a trap so an early `exit`/`set -e` abort still restarts. A gateway must never be left with Node-RED down. (This mirrors the boot-node rebuild's `finally`-guarded `PRAGMA foreign_keys=ON` discipline: the cleanup fires on the error path, not just the happy path.)

ChirpStack is unaffected (it reprovisions on restart via osi-bootstrap; the DB migration does not touch its state).

## D. First-run baselining (consumes Stage 0's `baseline-existing-db.js`)

The runner's preflight (`runner.js:19-25`) refuses to apply onto a schema with no stored fingerprints matching, and every live gateway has **no `schema_migrations` ledger at all**. So the first Stage-1 run on a device must baseline before applying:

1. Detect ledger state: query `SELECT COUNT(*) FROM schema_migrations` (guarding for the table's absence). If the table is absent or empty → this is a first run → baseline.
2. Run the §D(c) pre-baseline repair from Stage 0 if applicable: `scripts/repair-sync-outbox-v2.js /data/db/farming.db` (idempotent; adds the three v2 columns missing on pre-v2 gateways — verified missing on kaba100). It refuses if `sync_outbox` is absent entirely (the Uganda whole-table gap — but Uganda is excluded here, so on kaba100/Silvan the table exists).
3. Run `baseline-existing-db.js /data/db/farming.db` (no `--version`: head-down search, stamp at the highest passing N — expected **N=3** on the current fleet, per Stage 0 §B). Its contract (Stage 0 §E) is consumed **exactly**:
   - **Standard-deploy precondition:** the device must have completed a standard deploy of the CURRENT flows including a reboot so `sync-init-fn` converged the trigger set (Stage 0 §B). Convergence is by `DROP TRIGGER IF EXISTS` **followed by** `CREATE TRIGGER` on boot (verified: `sync-init-fn` runs 30 DROP + 30 CREATE — the CREATEs use `IF NOT EXISTS`, but the preceding unconditional DROP forces a rebuild of each trigger body regardless, so the live set converges to the deployed flows' bodies on every boot). In Stage 1 this is satisfied only from a **prior** deploy's boot — the boot-node convergence happens on Node-RED **start**, not file-fetch, and §C stops Node-RED before baselining. **Ordering consequence:** on a device whose *previous* boot ran older flows, the trigger bodies live in the DB are the old ones until the next Node-RED start. Since §C stops Node-RED *before* baselining, the live trigger set is whatever the last boot wrote. Therefore **baselining requires that the CURRENT flows were already deployed-and-booted in a prior deploy** — i.e. the operator runs a normal flows-only deploy (item 0.1) first, lets Node-RED restart and converge triggers, *then* runs the deploy that includes the Stage-1 migration step. This spec states that as an operator precondition (§G rollout order) and the runner's forward-drift comparator enforces it: against stale triggers, `baseline-existing-db.js` reports `changed` triggers and refuses — a feature, not a bug (Stage 0 §B).
   - **Forward-drift tolerance:** `analysis_views` (early-arrived via `ensure_analysis_views_schema`) is tolerated `extra_forward` at N=3; the chameleon `swt_1/2/3` allowlist is tolerated. Any `extra_unknown`/`missing`/`changed` → refuse.
4. **If baselining refuses** (no N passes): abort the migration step, restart Node-RED (§C), exit non-zero, leave the DB **exactly as found** (baseline stamps nothing on refusal — Stage 0 §E). The operator investigates out-of-band. This is the "biggest risk" guard: a bad baseline-stamp blesses a wrong schema; refusing is correct.
5. On subsequent deploys the ledger exists and is non-empty → skip baselining, go straight to §E (`applyPending` skips already-applied versions).

## E. `scripts/migrate-cli.js` — the runner entrypoint + off-device backup + restore

A new thin CLI (the `<migrate-cli>` plan §3 names), invoked as `node scripts/migrate-cli.js /data/db/farming.db --backup-dir <off-device-dir>`:

- **Inputs:** `<db-path>` (required, must exist — same anti-typo refusal as `restamp-fingerprints.js`); `--backup-dir <dir>` (required for the off-device copy; §C's stop must have happened — the CLI does not stop Node-RED itself, `deploy.sh` owns that bracket so the restart trap is in one place).
- **Pre-migration off-device backup (the DD9 "byte-verified backup fsync'd to a second path BEFORE the first destructive statement"):** before calling `applyPending`, if there is any pending `destructive` or `data` migration (checked via `loadMigrations` + the ledger's applied set), take an online `.backup` copy into `--backup-dir` (a path the operator supplies on a *different* filesystem where possible — the deploy tmp dir, not `/data/db`), run `PRAGMA integrity_check` on the copy, and **`fsync` the copy + its directory** (`fs.fsyncSync` on an `fs.openSync(..., 'r')` handle for the file and on the dir fd) so a power loss between backup and the destructive statement cannot lose the backup to the page cache. Refuse to proceed to `applyPending` if the copy's integrity_check ≠ `ok`. This is **in addition** to the runner's own same-filesystem `backupDb` — the runner's protects against a bad migration; this off-device one protects against SD-card death mid-migration. Record the off-device backup path to stdout/log.
- **Invoke** `applyPending(cliRunner(dbPath), { migrationsDir, appVersion: 'stage1-deploy', writersStopped: true })`. `writersStopped: true` is honest here (§C stopped Node-RED) and is what unlocks the destructive path.
- **Restore-on-failure (the DD9 "restore-on-failure actually invoked by the script"):** wrap `applyPending` in try/catch. On any throw:
  1. Log the failure and the migration it failed on.
  2. **Restore** by copying the off-device backup back over `/data/db/farming.db` (after removing any `-wal`/`-shm` sidecars the failed run left), then `PRAGMA integrity_check` the restored DB (must be `ok`) and confirm `verifyHead`/schema shape matches the pre-migration baseline. Restore uses a plain file copy of the pre-migration byte-image, not a partial replay — the whole point of the off-device image.
  3. If restore itself fails integrity_check, do NOT restart Node-RED against a corrupt DB: leave the DB in place, print the off-device backup path for manual recovery, exit with a distinct non-zero code so `deploy.sh`'s trap restarts Node-RED only if the restored DB is verified good. (Trade-off: a verified-corrupt DB with Node-RED down is a louder, safer failure than a silently-wrong DB serving a farm. The off-device backup is the recovery artifact.)
  4. Re-throw so `deploy.sh` treats the migration step as failed (non-zero) — but Node-RED still restarts via the trap **only** when the DB is verified-restored (step 3's gate).
- **Ledger-recorded:** the runner already records each applied migration in `schema_migrations` with `app_version='stage1-deploy'` and the backup path — no extra ledger writes here.
- **Never:** no baselining (that is §D / Stage 0's separate tool + blast radius); no `syncFingerprints` (the runner stamps per-migration); no writing application data.

**Backup retention:** the runner's `backupDb` already prunes to `keep=5` per `backup.js`. The off-device `--backup-dir` copies are the deploy script's responsibility; keep the last N per the operator runbook (default: keep this deploy's copy through the post-verify window, per §G).

## F. Retirement of the ad-hoc repair paths (enumerate what replaces each)

The `ensure_*` functions and `repair-pi-schema.js` are removed from the delivery path. Each replacement, verified against current DDL owners:

| Retired surface | What it does today | Replaced by |
|---|---|---|
| `ensure_dendro_schema` | idempotent `ADD COLUMN` for dendro columns on `device_data`/`dendrometer_*` | already in `seed-blank.sql` + `0001__baseline.sql` → carried by baseline (N covers it) or a future additive migration; no runtime `ADD COLUMN` needed once the device is at head |
| `ensure_zone_irrigation_calibration_schema` | idempotent zone-calibration table/columns | same — baseline/head |
| `ensure_analysis_views_schema` | `CREATE TABLE IF NOT EXISTS analysis_views` (+ the live shape) | **`0005__analysis_views.sql`** (Stage 0 §D(a)) — folded into the reference; `applyPending` no-ops it over the early-arrived live table |
| `ensure_chameleon_schema` | `ADD COLUMN` incl. the dead `swt_1/2/3` (Stage 0 §D(b)) | baseline (columns are in `0001`); the dead `swt_1/2/3` stay allowlisted (Stage 0 §D(b)) — not re-created |
| `ensure_gateway_health_schema` | fetches + execs `0002__gateway_health.sql` (already the migration file, additive-guarded) | **`0002` via the runner** — the runner replays it (`IF NOT EXISTS`, clean no-op on devices that got it early) |
| `scripts/repair-pi-schema.js` | live-Pi schema repair verb — **incident/boot-companion tooling, NOT a deploy step**. Verified: `deploy.sh` never references it (its callers are `scripts/test-history-helper.js` and the `sync-init-fn` companion per the skill decision table). | Its *repair role* is subsumed by the ledgered runner path + `restamp-fingerprints.js` (fingerprint recovery) + `baseline-existing-db.js` (first baseline) — but there is no deploy invocation to delete. It is **retired as the sanctioned live-repair verb**, not removed from `deploy.sh` (it was never there). The **devices-CHECK rebuild** it companions stays in `sync-init-fn` (the sanctioned exception) until Stage 2 / item 4.3 — Stage 1 does NOT remove that. Retiring `repair-pi-schema.js` itself is deferred to Stage 2 (it companions the boot-node rebuild that Stage 2 strips); Stage 1 only removes its *role* as a delivery mechanism, which was already only `ensure_*`, not this script. |

**Verification the retirement is safe:** `verify-no-stray-ddl.js` (origin/main-anchored count freeze, bans only *net increases* per its script header) must not regress — removing `ensure_*` DDL from `deploy.sh` *lowers* its per-surface counts, which the gate allows. The Stage-0 `0005` fold-in already moved `analysis_views` into the reference. The pre-baseline `repair-sync-outbox-v2.js` (Stage 0 §D(c)) stays as operator tooling until the fleet is baselined, then is deleted (consumed-or-deleted).

## G. Post-verify + rollout

**Post-verify (per DD9 + 0.2 canary gate):**
- The gateway's next heartbeat carries `schema_sig` (verified present in the heartbeat payload). After a successful Stage-1 deploy, `schema_sig` must change to the head value and `error_counts.total` must stay flat.
- The 0.2 heartbeat canary gate (`docs/superpowers/specs/…canary…` — item 0.2) is the tooling that refuses to advance the rollout until the target gateway reports N healthy heartbeats at the target `schema_sig`. Stage 1 rollout **consumes** that gate rather than re-implementing it.
- `verifyHead(cliRunner('/data/db/farming.db'), {migrationsDir})` returning `{ok:true}` is the on-device truth; the heartbeat is the remote proxy for it (the fleet's `sync_outbox` gaps mean the heartbeat is the only remote window — plan §5 prereq).

**Rollout order (operator sequence, each fully post-verified before the next):**
1. **Flows-only deploy first** (item 0.1) to the target so Node-RED restarts and `sync-init-fn` converges the current trigger set — the §D baselining precondition.
2. **kaba100** (demo, rebuildable, `admin`) — the mandated rehearsal-of-record device: fresh byte-copy rehearsal green (Stage 0 §F) → Stage-1 deploy → 0.2 canary hold → `schema_sig` = head, `0004` CHECK widened, row counts invariant.
3. **Silvan** (demo, rebuildable) — same procedure, its own fresh-copy rehearsal.
4. **Uganda: NOT in this item.** Item 2.1 combines Uganda's catch-up + baseline + Stage-1 in one rehearsed window (plan §5), hard-gated on osi-server 1.B4 deployed and 1.B1 proven on both demos.

**The one non-negotiable (plan §5, restated):** no artifact runs on a device until the identical artifact ran green on an **exact byte-copy of that device's DB** taken at execution time. Rehearsal-on-real-copy is the entire safety story. This spec's `migrate-cli.js` + baseline + backup/restore path is exercised end-to-end on a fresh kaba100/Silvan copy (the runbook, item 1.B2, executes it) before the live run.

## Rehearsal DoD (before any gateway's Stage-1 window — extends Stage 0 §F)

On a **fresh** byte-copy of the target gateway's DB (taken after the item-0.1 flows deploy, `.backup` → integrity_check → transfer):
0. `sqlite3` CLI present in the rehearsal environment (CI/workstation has it; on-device §B ensures it).
1. `repair-sync-outbox-v2.js` (Stage 0 §F step 0) then `baseline-existing-db.js` → stamps at N (expected 3).
2. `migrate-cli.js <copy> --backup-dir <scratch>` → off-device backup fsync'd + integrity-checked; `applyPending` applies `[4,5]`; `verifyHead` = `{ok:true}`.
3. **Restore-path rehearsal (new, load-bearing):** deliberately inject a failing migration on a *second* copy (e.g. a scratch `0006` that violates a CHECK during `data` apply) and prove `migrate-cli.js` restores the pre-migration byte-image, integrity_check = `ok`, and exits non-zero — the restore path must be *exercised*, not just coded (refactor-program "Risks": "The backup+restore path must be exercised on a real gateway DB copy before it runs live").
4. Postflight: `integrity_check` = `ok`, `foreign_key_check` = zero rows.
5. Row-count invariants (Stage 0 §F.5 list, headline `irrigation_schedules`) identical before-baseline vs after-applyPending-to-head.
6. Node-RED boots against the migrated copy (throwaway instance) with no schema-related errors.

Any rehearsal failure holds that gateway's window, full stop.

## Non-goals

- **Stage 2 / item 4.3** (boot-node DDL removal) — gated on two clean fleet deliveries including Uganda; `sync-init-fn` stays FROZEN here.
- **Uganda catch-up (#87 / item 2.1)** — its own rehearsed window; Uganda excluded from this rollout.
- **node-sqlite3 runtime runner adapter** — documented future; §B provisions the CLI instead.
- **Flipping `CONFIG_PACKAGE_sqlite3-cli=y` in the image** — a firmware-rebuild follow-up (needs a boot test); §B's `opkg install` is the delivery path for flashed gateways in the interim.
- **The 0.2 canary gate itself** — consumed here, specced/built as item 0.2.
- **Removing the boot-node `devices`-CHECK rebuild** — that is the sanctioned exception, removed in Stage 2.

## Definition of Done

- `scripts/migrate-cli.js` (runner invocation + off-device fsync'd backup + actually-invoked restore-on-failure) + `node --test` suite covering: fresh-baselined device carried to head; a pending-destructive detection triggering the off-device backup; an injected-failure run restoring the byte-image and exiting non-zero; missing-path refusal. Wired into `.github/workflows/migrations.yml`.
- `deploy.sh`: the §B0 full-migrations-corpus fetch, the §B CLI-provision gate, the §C Node-RED stop/restart trap bracket, the §D first-run baseline call, and the §E `migrate-cli.js` invocation — replacing the five `ensure_*` calls (lines 643–647). `ensure_*` function bodies removed; `verify-no-stray-ddl.js` still green (counts only drop). (No `repair-pi-schema.js` deploy invocation exists to remove — it is not called by `deploy.sh`; see §F.)
- Rehearsal DoD (above) executed and written up as evidence against a fresh kaba100 copy, **including the restore-path rehearsal** — not just claimed.
- `osi-schema-change-control` SKILL.md decision table updated: the "Any other on-device schema mutation" / "destructive on live" rows now point at the Stage-1 runner path (not "not currently supported") — a DoD deliverable, the skill is the domain law surface. (This is the sanctioned skill edit for this slice; no other existing-file edits.)
- No change to `sync-init-fn`, no Uganda touch, no live gateway in this slice (the live runs are item 1.B2's runbook).
- This document updated with the actual N found and any rehearsal surprises after the kaba100 rehearsal-of-record.

## Open decisions

None outstanding. The two structural constraints (CLI absence, Node-RED not stopped) are resolved in §B/§C as verified-fact corrections to DD9's framing; the restore path is made load-bearing (§E) and rehearsal-gated (Rehearsal DoD step 3) per the refactor program's explicit "exercise the restore path" risk line.
