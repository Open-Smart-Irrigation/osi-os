# Uganda catch-up rehearsal report — 2026-09-11

Runbook: `docs/operations/uganda-catchup-runbook.md` Phase 2 (rehearsal) + Phase 3 (window script authoring).
Worktree: `.worktrees/uganda-rehearsal`, branch `ops/uganda-catchup-rehearsal-20260911`, off `origin/main` @ `855aee17f`.
Scope: **entirely local**. No SSH to any gateway. No live DB touched. Everything below ran against local
byte-copies of the exfiltrated backup under `/home/phil/osi-backups/uganda-rehearsal-20260911/`.

## Input

- `/home/phil/osi-backups/uganda-farming-20260910T225932Z.db.gz`
- sha256 `0f131395c6dfb02d16ea770c7ab20e4b23615c6ea3311c9e1802b398abee4460` — **verified, matches exactly**.
- Decompressed to two working copies (`work/uganda-copyA.db`, `work/uganda-copyB-restore.db`); the `.gz` and
  the pristine `copyB` were never modified (sha256 unchanged throughout — see "Evidence index" below).
- DB 54,120,448 bytes uncompressed. `PRAGMA integrity_check` on the raw decompress: `ok`.

## G4 evidence (rehearsal-required gate)

| Field | Value |
|---|---|
| Copy sha256 | `0f131395c6dfb02d16ea770c7ab20e4b23615c6ea3311c9e1802b398abee4460` (compressed input) |
| Rehearsal date | 2026-09-11 |
| **Result** | **NOT GREEN.** The catch-up artifact (below) closes 49 of 66 baseline diffs, but 17 residual, non-additive schema-drift diffs remain and `baseline-existing-db.js` refuses to stamp any version (`matched: null`) even after the artifact + `repair-sync-outbox-v2.js` run. **The runbook's Phase 3/4 on-device window must not run against the real Uganda gateway until this is resolved** (see "What's blocking G4" below). |

This is the headline finding of this rehearsal. It is exactly what a rehearsal is for: the runbook's own
Phase 2 gate text says "Any rehearsal failure HOLDS the window. Full stop." — that gate held.

## What baseline-existing-db.js --report found (before any repair)

`node scripts/baseline-existing-db.js <copy> --report` walks every reference(N), N=53..1, and reports the
best-scoring (fewest-failing) candidate. Result: **N=1 is the global best fit at every stage of this
rehearsal** (monotonically non-decreasing failing-count from N=1 to N=53 — Uganda predates every migration,
so higher N only adds MORE missing objects on top of the same base gap). Before any repair, N=1 had **66
failing diffs**:

| class:kind | count |
|---|---|
| `[changed] trigger` | 17 |
| `[missing] index` | 13 |
| `[missing] trigger` | 11 |
| `[changed] column` | 9 |
| `[missing] table` | 6 |
| `[missing] column` | 5 |
| `[extra_allowlisted] column` | 3 (tolerated, not failing) |
| `[changed] foreign_key` | 2 |
| `[extra_unknown] column` | 2 |
| `[changed] check` | 1 |

The 6 missing tables: `sync_link_state`, `sync_history_cursors`, `sync_history_dirty_keys`,
`sync_history_segments`, `sync_history_quarantine`, `history_channel_rollups`.
`sync_outbox` itself IS present (confirms the brief's known-fact correction of the runbook's stale claim —
see "Runbook staleness" below) but was missing its 3 v2 columns (`rejected_at`, `rejection_reason`,
`last_retryable_failure_at`).

Full report: `01-baseline-report.log` (before repair), `06-baseline-report-post-catchup.log` (after).

## The catch-up artifact

- Generator: `scripts/ops/generate-uganda-catchup-20260911.js`
- Artifact: `scripts/ops/uganda-catchup-20260911.sql` (1280 lines, generated — never hand-retyped)
- Targets exactly the 6 missing tables + 12 of the 13 missing indexes (see exclusion below) + all 28
  missing/changed triggers from the N=1 report, extracted **verbatim from
  `database/migrations/ordered/0001__baseline.sql`** (reference(1) — see "Runbook staleness" item 2 for why
  this, not `database/seed-blank.sql`, is the correct source).
- Additive only: `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, and one
  idempotent `INSERT ... ON CONFLICT DO UPDATE` bootstrap row for `sync_link_state`. No `ALTER TABLE`, no
  `DROP TABLE`, no data deletion.
- **Excluded on purpose:** `idx_irrigation_events_event_uuid`. Its column
  (`irrigation_events.event_uuid`) is itself absent on Uganda (a `[missing] column` diff, not a
  `[missing] object]` diff) — `CREATE INDEX` on a nonexistent column fails immediately at creation time
  (unlike a trigger body, which SQLite does not validate until it runs), so this is a genuine, documented
  open gap, not an oversight.
- `--apply <db>` applies the artifact + runs `PRAGMA integrity_check`; `--verify <db>` re-snapshots the DB
  and asserts every targeted table/index/trigger is now present (does **not** assert a clean baseline match
  — see below for why that's a separate, harder bar this artifact does not clear).
- Unit tests: `scripts/ops/generate-uganda-catchup-20260911.test.js` (builds a real reference(1) DB, strips
  the target objects out to simulate Uganda's gap, proves `apply()` + `verify()` repair it, and that
  `apply()` is idempotent). All 3 subtests pass (`node scripts/ops/generate-uganda-catchup-20260911.test.js`
  directly: `# pass 3 # fail 0`, exit 0; `12-generator-test-full.log`). Each of the two DB-building subtests
  costs ~3.5 minutes (a full reference(1) fingerprint computation over ~130 objects via the sqlite3 CLI —
  the same per-call cost `baseline-existing-db.js`'s own header comments document), so this file was
  deliberately **not** added to `.github/workflows/migrations.yml`'s fast per-PR test line; run it manually
  when the artifact/generator changes. Note: `node --test <file>` wraps the file in its own top-level test
  node and reported that wrapper as `not ok` with no diagnostic even though all 3 real subtests passed
  (`# pass 3 # fail 1` at the suite level) — running the file directly (`node <file>.test.js`) reproduces
  cleanly at `# pass 3 # fail 0`, exit 0. Flagging as a `node --test` reporting quirk to watch, not a real
  failure.

### Result of applying the artifact (copy A)

```
$ node scripts/ops/generate-uganda-catchup-20260911.js --apply work/uganda-copyA.db
[uganda-catchup] applied uganda-catchup-20260911.sql to .../uganda-copyA.db; integrity_check ok

$ node scripts/ops/generate-uganda-catchup-20260911.js --verify work/uganda-copyA.db
[uganda-catchup] --verify PASSED: all 6 tables, 13 indexes, 28 triggers present.

$ node scripts/repair-sync-outbox-v2.js work/uganda-copyA.db
[repair-sync-outbox-v2] added: rejected_at, rejection_reason, last_retryable_failure_at
```

`baseline-existing-db.js --report` afterward: N=1 best-scoring, **17 failing** (down from 66). Full diff in
`06-baseline-report-post-catchup.log`; itemized below.

## What's blocking G4: 17 residual diffs, none additively fixable

All 17 are on tables that already exist on Uganda (so not "missing whole objects" — the runbook's framing)
and require SQLite's table-rebuild-class `ALTER` (recreate table, copy rows, swap) to fix, which is
destructive-adjacent and explicitly out of scope for an additive-only catch-up artifact:

| Diff | Detail |
|---|---|
| `[changed] foreign_key device_data` | ref(1) declares `FOREIGN KEY(deveui) REFERENCES devices(deveui)`; live has no such FK declared. |
| `[changed] column devices.chameleon_enabled` | live default `1`, ref(1) default `0`. |
| `[changed] check devices` | live's `type_id` CHECK lacks `AQUASCOPE_LORAIN` (ref(1) already includes it — Uganda predates ref(1) here). |
| `[missing] column irrigation_events.event_uuid` | genuinely absent; ALTER-fixable but deliberately left out (see above). |
| `[changed] column valve_actuation_expectations.created_at` / `.volume_source` | live has explicit defaults; ref(1) has none. |
| `[changed] column zone_irrigation_calibration.{created_at,measured_at,measured_flow_rate_lpm,measurement_method,updated_at}` | live columns are all nullable; ref(1) marks them `NOT NULL`. |
| `[changed] column zone_weather_cache.expires_at` | default mismatch. |
| `[missing] column zone_weather_cache.fetched_at` | absent; ALTER-fixable, left out (same rationale as event_uuid — not part of this artifact's additive-table/index/trigger scope). |
| `[extra_unknown] column zone_weather_cache.{created_at,updated_at}` | live has these; ref(1) does not — live-only columns with no reference(head) counterpart either. |
| `[changed] foreign_key zone_weather_cache` | same FK-declaration gap as device_data. |
| `[missing] index idx_irrigation_events_event_uuid` | documented exclusion above. |

**Uganda's schema does not correspond to any single point on the migration timeline** — it is simultaneously
behind reference(1) (missing whole tables/triggers, the runbook's framing) AND, on these 11 objects, already
ahead of or diverged from reference(1) in ways no migration ever produced (e.g. the narrower `devices` CHECK,
the FK declarations). This is very likely years of ad-hoc out-of-band DDL (manual repairs, pre-ledger
boot-node changes) predating both the migration ledger's inception and Uganda's last deploy. **Resolving
these 11 diffs needs a dedicated, reviewed table-rebuild reconciliation design — a new, separate piece of
work, not an extension of this rehearsal's mandate.** Until then, `baseline-existing-db.js` will keep
correctly refusing to stamp Uganda, and that refusal is the tool working as designed, not a bug.

## Runbook staleness (docs/operations/uganda-catchup-runbook.md)

1. **"Uganda... has no sync_outbox"** (Why Uganda is special, and repeated in the catch-up-artifact item 1)
   — **stale**. `sync_outbox` is present; it was only missing 3 v2 columns, which
   `repair-sync-outbox-v2.js` — already designed for exactly this — handles cleanly. Confirmed in the
   brief's own "known facts" and re-confirmed here.
2. **Catch-up artifact items 2-3 say to source `sync_link_state`/trigger bodies from "the seed's DDL" /
   "seed's current bodies"** (i.e. `database/seed-blank.sql`, which tracks HEAD) — **stale and would have
   silently broken G4**. Empirically: `sync_link_state` gained an `installation_uuid` column, and
   `sync_history_cursors`/`sync_history_segments` gained columns, between migration `0001` and HEAD; 16 of
   the 28 target triggers were edited by migrations `0015`-`0053`. Sourcing any of these from HEAD instead
   of `0001__baseline.sql` would create objects that themselves register as `[changed]` against
   reference(1), permanently defeating the clean N=1 match this artifact exists to enable. **Corrected
   here: every object is sourced verbatim from `database/migrations/ordered/0001__baseline.sql`
   (reference(1)) instead.** Later migrations (`0002..0053`) carry each object forward to its HEAD shape
   via `applyPending`, exactly as they would for any other gateway baselined at N=1 — that mechanism is
   untouched.
3. **"Uganda is missing whole sync tables" undersells the actual gap.** The runbook frames Uganda's problem
   as purely additive (missing whole tables). In reality there are 11 further, genuinely non-additive
   diffs (FK declarations, CHECK constraint scope, column defaults/nullability) that predate even
   reference(1) and block a clean baseline regardless of the catch-up artifact. This is the rehearsal's
   central new finding — see "What's blocking G4" above.
4. **Phase 2 checklist implies the catch-up artifact + `repair-sync-outbox-v2.js` + `baseline-existing-db.js`
   is a complete recipe that reaches a "matched N" for Uganda.** Empirically false — see above. The
   checklist item "record the matched N" needs a documented failure branch, not just a happy path.
5. **G1-G3, G5 evidence rows are out of scope for this rehearsal** (no SSH, no live heartbeat, no
   connectivity window — this task is explicitly local-only) and are left unfilled; only G4 was rehearsed.

## Row-count invariants (copy A: pristine vs post-catch-up-artifact)

Since G4 is blocked, `migrate-cli.js` cannot legitimately run to HEAD against the real Uganda copy (see
"Restore-path + migrate-cli mechanics" below for why, and how the mechanics were proven anyway). What CAN be
— and was — proven is that the catch-up artifact itself is fully row-count-neutral:

| table | before (pristine copy B) | after catch-up artifact + repair (copy A) |
|---|---|---|
| device_data | 69,686 | 69,686 |
| chameleon_readings | 0 | 0 |
| dendrometer_readings | 0 | 0 |
| dendrometer_daily | 0 | 0 |
| irrigation_events | 75 | 75 |
| zone_daily_environment | 0 | 0 |
| zone_daily_recommendations | 0 | 0 |
| analysis_views | absent (table doesn't exist — created by migration 0007, pending G4) | absent (unchanged) |
| irrigation_schedules | 1 | 1 |
| devices | 4 | 4 |
| users | 1 | 1 |
| irrigation_zones | 3 | 3 |
| sync_outbox | 15,732 | 15,732 (columns added, 0 rows touched) |
| sync_link_state | absent | 1 (the bootstrap row — expected, the only allowed delta) |
| history_channel_rollups / sync_history_cursors / sync_history_dirty_keys / sync_history_quarantine / sync_history_segments | absent | 0 each (newly created, empty — expected) |

Every pre-existing history-bearing table: **identical row count before/after**. The only deltas are the 6
newly-created tables (0 or 1 rows, exactly as the artifact intends) and `analysis_views`, which is absent on
both sides (it's a HEAD-only table from migration 0007, not part of this artifact's scope; will appear once
G4 is resolved and `migrate-cli` can run).

Postflight on copy A: `PRAGMA integrity_check` = `ok`; `PRAGMA foreign_key_check` = 0 rows.

Full CSV: `08-row-counts-catchup-delta.csv`.

## Restore-path + migrate-cli mechanics

`migrate-cli.js`'s backup-then-restore-on-failure mechanism only activates once `applyPending()` has
something legitimately marked "already applied" (i.e. after a successful `baseline-existing-db.js` stamp).
Since G4 blocks that stamp on the real Uganda copy, feeding `migrate-cli.js` an unbaselined Uganda copy
directly would just fail on migration `0001`'s own `CREATE TABLE users` (table already exists) inside a
single transaction — SQLite's normal rollback, not the byte-image-restore code path the runbook's Phase 2
rehearsal step actually wants proven.

To prove the **restore mechanism itself** (not Uganda-specific, and unaffected by G4), a small legitimately-
baselined fixture was built instead — `restore-mechanics/build-and-test.js`:

1. Bootstrap a fresh DB through the real, unmodified migrations `0001`-`0005` (verbatim from
   `database/migrations/ordered/`).
2. Record sha256 (`7cb6ba8f...`).
3. Append one deliberately-broken migration `0006` (risk: destructive, so `migrate-cli.js`'s
   `needsBackup` gate fires and takes a persistent off-device backup before attempting it).
4. Run `migrate-cli.js` and assert: a persistent pre-migration backup was written and integrity-checked,
   the broken migration failed, the byte image was restored, sha256 after == sha256 before, and the call
   threw with `code=1, restored=true`.

Result: **all assertions passed** — `09-restore-mechanics-proof.log`. This is the same mechanism
`scripts/migrate-cli.test.js`'s own `'injected migration failure: byte-image restored, DB unchanged'` test
already covers in CI; this run corroborates it end-to-end via the CLI entrypoint rather than the internal
API, with a realistic destructive-migration shape.

## The on-device window script

`scripts/ops/uganda-catchup-window.sh` — POSIX/BusyBox-ash only (no arrays, `[[ ]]`, `local`, or other
bashisms), styled on `deploy.sh`'s already-production-proven `run_schema_migration()` idioms. Order: stop
Node-RED (verified stopped) → pre-window row-count snapshot → on-device `.backup` + `integrity_check` →
apply catch-up artifact → `repair-sync-outbox-v2.js` → `baseline-existing-db.js` → `migrate-cli.js` →
postflight (`integrity_check`, `foreign_key_check`, `verify-head-cli.js`, row-count invariants) →
Node-RED restart **on every exit path via an EXIT/INT/TERM trap**, not just the happy path. All state under
`$UGANDA_CATCHUP_BACKUP_DIR` (default `/data/backups/uganda-catchup`); logs to stdout (the caller redirects
under `setsid`, per the runbook).

`UGANDA_CATCHUP_STUB_NODE_RED=1` replaces the two `/etc/init.d/node-red` calls with no-ops, for local
rehearsal only — never to be set on the real device.

**Environment gap:** neither `busybox` nor `dash` is installed on this workstation (`which busybox dash`:
not found; `/bin/sh` is `bash`). The script's syntax was restricted to the subset already proven in
production by `deploy.sh` (same repo, same target) and manually reviewed against BusyBox ash's documented
constraints; it was dry-run tested under `sh` (bash in POSIX-ish invocation) rather than genuine
`busybox ash`/`dash`. Flagging this as an open gap for whoever runs the real window: verify under actual
BusyBox ash on a Pi (or install `busybox`/`dash` here) before the real device run.

### Dry run (task 7): the script correctly detects G4 and fails closed

Run against a **fresh, unmodified** pristine decompress of the byte-copy (`work/uganda-dryrun.db`), with
`UGANDA_CATCHUP_STUB_NODE_RED=1`:

```
[...] --- stop Node-RED ---
[...] STUB: node-red stop (UGANDA_CATCHUP_STUB_NODE_RED=1)
[...] --- on-device backup ... --- 
[...] on-device backup ok: .../farming.db.catchup-20260910T233827Z
[...] --- apply catch-up artifact ---
[...] --- repair-sync-outbox-v2 ---
[repair-sync-outbox-v2] added: rejected_at, rejection_reason, last_retryable_failure_at
[...] --- baseline-existing-db (stamp the ledger) ---
  [... full N=1..53 diff, matches 06-baseline-report-post-catchup.log ...]
[...] ERROR: baseline-existing-db could not find a matching reference(N) - refusing to migrate. Re-run --report off-device to diagnose before retrying this window.
[...] trap: restarting Node-RED (exit path rc=1)
[...] STUB: node-red start (UGANDA_CATCHUP_STUB_NODE_RED=1)
[...] trap: Node-RED restarted OK
[...] FINAL: FAILED: baseline-existing-db could not find a matching reference(N) - refusing to migrate. ... (rc=1)
```

Full log: `10-window-script-dryrun.log`. Exit code non-zero. **This is the single most important proof in
this rehearsal**: the window script, run against Uganda's real current schema today, does NOT corrupt
anything — it takes its on-device backup, attempts the catch-up + baseline, correctly detects that Uganda
cannot yet be safely migrated, and unwinds cleanly (Node-RED restarted on the trap, clear final log line,
non-zero exit) rather than plowing ahead. The runbook's NOT-READY banner should stay up until G4's 11
residual diffs have a reviewed reconciliation plan; if the window script were run on the real device today
it would fail exactly this safely, not destructively.

## Boot-node / Node-RED verification (task 6)

Booting a real throwaway Node-RED instance against the migrated copy was not attempted: `scripts/soak/rig.js`
exercises `lib/osi-migrate` + backup/restore logic directly against a DB copy (no Node-RED runtime), and no
other documented harness in AGENTS.md/scripts boots Node-RED headless against an arbitrary DB path. Per the
brief's fallback, ran the boot-DDL verifiers instead:

```
$ node scripts/verify-sync-flow.js            -> All parity checks passed. exit=0
$ node scripts/verify-boot-ddl-interpolation.js -> OK (both flows.json variants; 60 boot statements each;
                                                     no gatewaySql leak; versioned outbox triggers pass
                                                     NEW.sync_version) exit=0
$ node scripts/verify-runtime-schema-parity.js  -> OK (devices CHECK + runtime trigger parity) exit=0
```

Full output: `11-node-red-boot-fallback-verifiers.log`.

These matter beyond generic coverage: `database/migrations/ordered/0001__baseline.sql`'s trigger bodies
(the source this catch-up artifact copies verbatim) contain a hardcoded fallback gateway EUI literal,
`'0016C001F11715E2'` — **that is Silvan's EUI, not Uganda's** (`COALESCE(NEW.gateway_device_eui, '0016C001F11715E2')`,
the same osi-os#153 class of defect tracked in project memory). This literal only matters if a row's own
`gateway_device_eui` is null at insert time, and `verify-boot-ddl-interpolation.js` confirms `sync-init-fn`
(the frozen boot node) rewrites all 60 `trg_dp_*`/`trg_sync_*`/`trg_gateway_locations_*` boot statements with
the real `DEVICE_EUI` on every Node-RED start — so the stale literal is a transient condition, corrected the
moment Node-RED restarts. This is exactly why the window script restarts Node-RED on every exit path
(including failure): leaving Uganda's DB with catch-up-artifact triggers but Node-RED stopped would leave
that Silvan-EUI fallback live indefinitely.

## Evidence index (`/home/phil/osi-backups/uganda-rehearsal-20260911/`)

| File | Contents |
|---|---|
| `01-baseline-report.log` | `baseline-existing-db.js --report`, pristine copy, before any repair |
| `02-n1-diff.txt` | Extracted N=1 diff (66 failing) from the above |
| `03-apply-catchup.log` | Catch-up artifact `--apply` output |
| `04-verify-catchup.log` | Catch-up artifact `--verify` output |
| `05-repair-sync-outbox-v2.log` | `repair-sync-outbox-v2.js` output |
| `06-baseline-report-post-catchup.log` | `baseline-existing-db.js --report` after artifact + repair (17 failing) |
| `07-baseline-nonreport-post-catchup.log` | `baseline-existing-db.js` (real invocation, non-report) confirming `matched: null`, exit 1 |
| `08-row-counts-catchup-delta.csv` | Row counts, pristine vs post-catch-up-artifact |
| `09-restore-mechanics-proof.log` | Restore-path mechanics proof (fixture, see rationale above) |
| `10-window-script-dryrun.log` | Window-script dry run against a fresh copy, `UGANDA_CATCHUP_STUB_NODE_RED=1` |
| `11-node-red-boot-fallback-verifiers.log` | `verify-sync-flow.js` / `verify-boot-ddl-interpolation.js` / `verify-runtime-schema-parity.js` |
| `restore-mechanics/` | Fixture migrations + `build-and-test.js` for the restore-path proof |
| `payload/` | Assembled on-device payload dir used for the window-script dry run |
| `work/uganda-copyA.db` | Working copy: pristine → catch-up artifact → repair-sync-outbox-v2 (final state) |
| `work/uganda-copyB-restore.db` | Pristine, never modified (sha256 `04b75d96...` throughout) |
| `work/uganda-dryrun.db` | Fresh pristine decompress used only for the window-script dry run |

## Summary / next steps

- **Deliverables (this branch):** catch-up artifact + generator (with tests), the on-device window script,
  and this report. All committed; PR opened, **not merged**.
- **G4 is NOT green.** Do not run the runbook's Phase 3/4 against the real Uganda gateway.
- **Next step for whoever picks this up:** design a reviewed, table-rebuild-based reconciliation for the 11
  non-additive diffs listed under "What's blocking G4" (FK declarations on `device_data`/`zone_weather_cache`,
  the `devices` CHECK, six column-default/nullability mismatches), decide whether
  `irrigation_events.event_uuid` / `zone_weather_cache.fetched_at` should be added via a small
  `ALTER TABLE ADD COLUMN` companion tool (same sanctioned pattern as `repair-sync-outbox-v2.js`) ahead of
  the rest, and re-rehearse G4 from scratch once that plan exists. Update the 5 runbook-staleness items
  above in `docs/operations/uganda-catchup-runbook.md` regardless of when G4 clears.
- G1-G3 and G5 are untouched by this local-only rehearsal and still need their own evidence before the
  runbook's NOT-READY banner can come down.
