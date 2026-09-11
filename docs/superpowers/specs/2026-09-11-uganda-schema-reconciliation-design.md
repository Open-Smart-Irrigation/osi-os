# Uganda schema reconciliation: table-rebuild design (2026-09-11)

Status: design + rehearsed artifact, **awaiting adversarial review**. Nothing in this
document has been run against the real Uganda gateway. Every step below was
rehearsed against local byte-copies of `/home/phil/osi-backups/uganda-farming-20260910T225932Z.db.gz`
(sha256 `0f131395c6dfb02d16ea770c7ab20e4b23615c6ea3311c9e1802b398abee4460`), never SSH,
never a live DB. See the companion report,
`docs/operations/uganda-catchup-rehearsal-20260911-report.md` and its
"rebuild" addendum, for the full evidence trail.

This document is written FOR a senior adversarial reviewer who has not seen
the rehearsal. Every assumption and every irreversible step is stated
explicitly. Read `docs/operations/uganda-catchup-rehearsal-20260911-report.md`
first - it establishes that G4 (Uganda's schema baseline) is **NOT GREEN**
and describes the additive catch-up artifact this design continues from.

## 1. Problem recap

After the additive catch-up artifact (`scripts/ops/uganda-catchup-20260911.sql`)
and `scripts/repair-sync-outbox-v2.js` run, Uganda's live schema still has 17
diffs against `reference(1)` (= `database/migrations/ordered/0001__baseline.sql`,
the shape `baseline-existing-db.js` needs to stamp N=1). All 17 are on tables
that already exist - not missing whole objects - so none of them is fixable by
`CREATE ... IF NOT EXISTS`. SQLite cannot `ALTER` a constraint, a `CHECK`, a
column's `NOT NULL`-ness, or a column's default in place
(https://sqlite.org/lang_altertable.html §7, "Making Other Kinds Of Table
Schema Changes" - the 12-step procedure). The only mechanism is: create a
canonical replacement table, copy rows across with an explicit column
mapping, drop the old table, rename, recreate indexes/triggers.

## 2. Data audit (ground truth)

Produced by `scripts/ops/uganda-schema-audit.js` (read-only; never writes to
the target DB - this is a hard assertion inside the script, not just a
docstring claim, see its `sha256(before) === sha256(after)` check). Run
against the pristine decompressed copy
(`/home/phil/osi-backups/uganda-rehearsal-20260911/rebuild/work/uganda-audit.db`,
sha256 `04b75d9688c093ebf3bbab52765d72a1ad21938bc94c06f763b0cf14ecb2136d` -
matches the rehearsal report's pristine-copy sha256 throughout). Full JSON:
`docs/operations/uganda-catchup-rehearsal-20260911-report.md`'s rebuild
addendum links the raw output; the facts below are extracted from it.

### 2.1 Exact 17-diff list (post catch-up-artifact + repair-sync-outbox-v2, live vs reference(1))

Verified directly with `node scripts/semantic-schema-compare.js <post-catchup-copy> <reference(1)-db>`
(both built fresh in this rehearsal), not just paraphrased from the earlier
report - the counts below are re-derived and confirmed to still be exactly
17, matching the rehearsal report's "What's blocking G4" table:

| # | Table | Diff | Data implication (from the audit) |
|---|---|---|---|
| 1 | `device_data` | `[changed] foreign_key` - missing `FOREIGN KEY(deveui) REFERENCES devices(deveui) ON DELETE CASCADE` | **0 orphans** (`SELECT COUNT(*) FROM device_data WHERE deveui NOT IN (SELECT deveui FROM devices)` = 0, of 69,686 rows) |
| 2 | `devices` | `[changed] column chameleon_enabled` | live: `INTEGER NOT NULL DEFAULT 0`; ref(1): `INTEGER DEFAULT 0` (nullable). **Correction to the rehearsal report's paraphrase**: this is a **nullability** diff (`notnull` 1 vs 0), not a default-VALUE diff (both sides default to `0`) - the report's "live default 1 vs 0" wording was imprecise; the semantic-schema-compare column tuple is `name\|type\|notnull\|default\|pk`, and only the `notnull` field differs (`chameleon_enabled\|integer\|1\|0\|0` vs `chameleon_enabled\|integer\|0\|0\|0`). All 4 live `devices` rows currently have `chameleon_enabled = 0` (not NULL), so relaxing to nullable is a pure widening - no data at risk either direction. |
| 3 | `devices` | `[changed] check` - live CHECK lacks `AQUASCOPE_LORAIN` | Live `type_id` distribution: `KIWI_SENSOR` ×3, `STREGA_VALVE` ×1. **0 rows outside the canonical 6-member set** (`KIWI_SENSOR, STREGA_VALVE, DRAGINO_LSN50, TEKTELIC_CLOVER, SENSECAP_S2120`) and obviously 0 rows using `AQUASCOPE_LORAIN` (adding it only widens the CHECK). |
| 4 | `irrigation_events` | `[missing] column event_uuid` | 75 rows, all would need the column added (nullable, no backfill - see §3.3) |
| 5 | `valve_actuation_expectations` | `[changed] column created_at` - live has `DEFAULT (strftime(...))`, ref(1) has none | Both NOT NULL; 34/34 rows already have a real value (0 NULLs either way) |
| 6 | `valve_actuation_expectations` | `[changed] column volume_source` - live has `DEFAULT 'unknown'`, ref(1) has none | Both NOT NULL; 34/34 rows already have a real value |
| 7-11 | `zone_irrigation_calibration` | `[changed] column` ×5 (`created_at`, `measured_at`, `measured_flow_rate_lpm`, `measurement_method`, `updated_at`) - live nullable, ref(1) `NOT NULL` | 1 row total; **0 NULLs in any of the 5 columns** |
| 12 | `zone_weather_cache` | `[changed] column expires_at` - live nullable, ref(1) `NOT NULL` | **0 rows** in the table on this copy |
| 13 | `zone_weather_cache` | `[missing] column fetched_at` | 0 rows - no backfill needed on this copy, but the mapping must still be correct for whatever's live at run time (see §3.6) |
| 14-15 | `zone_weather_cache` | `[extra_unknown] column` ×2 (`created_at`, `updated_at`) | 0 rows |
| 16 | `zone_weather_cache` | `[changed] foreign_key` - missing `FOREIGN KEY(zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE` | 0 rows - 0 orphans trivially |
| 17 | `irrigation_events` | `[missing] index idx_irrigation_events_event_uuid` | Same 75 rows as #4; blocked on #4's column existing first (documented exclusion in the catch-up artifact) |

Row counts for all 6 tables in scope: `device_data` 69,686; `devices` 4;
`irrigation_events` 75; `valve_actuation_expectations` 34;
`zone_irrigation_calibration` 1; `zone_weather_cache` 0.

**Because `zone_weather_cache` has 0 rows on this copy**, several of the
riskiest-looking decisions below (the FK, the `expires_at` NOT NULL, the
`updated_at` drop) are currently zero-risk in practice - but the design and
the generated artifact's preflight guards treat the table as if it could have
rows by the time the real window runs (it is a live cache table refreshed by
backend code, so an empty audit result today is not a guarantee at run time).
Every guard below is written against "whatever the data says when the artifact
actually runs," not just today's audit snapshot - see §5.

### 2.2 What the audit does NOT need to worry about

- No table beyond these 6 carries any of the 17 diffs.
- No other live table has a foreign key pointing at any of these 6 tables
  (verified: `grep`-equivalent scan of every `CREATE TABLE` in reference(1)
  for `REFERENCES (valve_actuation_expectations|zone_irrigation_calibration|zone_weather_cache)` -
  zero hits). Only `devices` has FK children, and only `device_data` is one of
  the six that is also its own diff target.
- `devices` DOES have FK children beyond `device_data`: `dendrometer_readings`,
  `dendro_baselines`, `weather_station_zones`, `chameleon_readings` all declare
  `FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE` in
  reference(1) and are NOT in this rebuild's scope (no diff against them was
  reported) - but they are exactly the population at risk if `devices` is
  rebuilt with FK enforcement ON. See §4 (FK fence).

## 3. Column mapping, per table

Column-name-set equality between the live (post-catch-up) schema and
reference(1) was verified directly (`PRAGMA table_xinfo` diffed by name) for
every one of the 6 tables: **zero live-only or reference-only column names**
on any of them except the two explicitly listed drifts
(`zone_weather_cache.{created_at,updated_at}` live-only,
`zone_weather_cache.fetched_at` / `irrigation_events.event_uuid`
reference-only). This means every rebuild below is a **1:1 column mapping by
name** except where stated.

### 3.1 `devices` (rebuild)

Canonical DDL: reference(1)'s `CREATE TABLE devices (...)` verbatim (44
columns), CHECK widened to the 6-member canonical set including
`AQUASCOPE_LORAIN`, `chameleon_enabled` reverted to nullable. Column mapping:
identical name-for-name, all 44 columns. No data loss, no orphan risk (CHECK
only tightens by widening, `chameleon_enabled`'s NOT NULL relaxes). Rebuilt
FIRST (see §4 - it is the parent of 5 FK children).

### 3.2 `device_data` (rebuild)

Canonical DDL: reference(1)'s `CREATE TABLE device_data (...)` verbatim (47
columns) plus the FK declaration. Column mapping: identical name-for-name, all
47 columns. **Orphan guard required**: the artifact's `apply()` preflights
`SELECT COUNT(*) FROM device_data WHERE deveui NOT IN (SELECT deveui FROM devices)`
immediately before running this table's block and refuses (does not run any
DDL) if it is nonzero. Audited today: 0. Rebuilt SECOND, immediately after
`devices`, inside the SAME transaction (so the FK it declares resolves against
the already-canonical `devices`).

### 3.3 `irrigation_events` (ALTER, not a rebuild)

`event_uuid` is `TEXT` with no `NOT NULL` and no default in reference(1) - a
plain nullable column. SQLite's `ALTER TABLE ... ADD COLUMN` is sufficient and
safe for this shape (no full-table copy is required by SQLite for a nullable,
default-less `ADD COLUMN`). All 75 existing rows get `event_uuid = NULL` after
the `ALTER`, which is correct: nothing here retroactively backfills history -
each row's `event_uuid` gets populated going forward by
`trg_sync_irrigation_events_uuid_ai` (an `AFTER INSERT` trigger, already
restored by the additive catch-up artifact) only on NEW inserts; existing rows
stay `NULL` forever unless something else touches them, which nothing here
does. `CREATE UNIQUE INDEX idx_irrigation_events_event_uuid` is then safe to
add even with 75 existing `NULL`s: SQLite's default `UNIQUE` semantics treat
every `NULL` as distinct from every other `NULL`, so a unique index over an
all-`NULL` column never conflicts. **This is why `irrigation_events` is in the
"6 non-additive tables" list in the rehearsal report but does NOT go through
the rebuild procedure here** - its exclusion from the additive catch-up
artifact was a scope-discipline decision (the catch-up artifact's charter was
"whole missing objects only"), not evidence that it needs a full rebuild.

### 3.4 `valve_actuation_expectations` (rebuild)

Canonical DDL: reference(1)'s `CREATE TABLE valve_actuation_expectations (...)`
verbatim (17 columns), which drops the live-only `DEFAULT` clauses on
`created_at` and `volume_source` (both stay `NOT NULL`). Column mapping:
identical name-for-name, all 17 columns. Audited: 0/34 rows have a NULL in
either column today, so the rebuild's plain `INSERT` (which enforces `NOT
NULL` on the new table immediately) cannot fail on this data. Losing the
DB-side `DEFAULT` only affects future `INSERT`s that omit these columns; every
known write path (STREGA valve command handling) already supplies both
explicitly.

### 3.5 `zone_irrigation_calibration` (rebuild)

Canonical DDL: reference(1)'s `CREATE TABLE zone_irrigation_calibration (...)`
verbatim (7 columns), 5 of which go nullable -> `NOT NULL`. Column mapping:
identical name-for-name, all 7 columns. **NULL guard required**: `apply()`
preflights `SELECT COUNT(*) FROM zone_irrigation_calibration WHERE <col> IS NULL`
for each of the 5 columns and refuses if any is nonzero. Audited: 0/1 rows
have any NULL among the 5.

### 3.6 `zone_weather_cache` (rebuild)

Canonical DDL: reference(1)'s `CREATE TABLE zone_weather_cache (...)` verbatim
(7 columns + composite PK + FK), which:
- adds `fetched_at TEXT NOT NULL` (missing live),
- makes `expires_at` `NOT NULL` (nullable live),
- drops the live-only `created_at`/`updated_at` (both `NOT NULL DEFAULT
  CURRENT_TIMESTAMP` live, no reference(1) counterpart),
- adds `FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE
  CASCADE` (undeclared live).

**Mapping decision - `fetched_at <- created_at`.** `zone_weather_cache` is an
upsert-shaped cache table (composite PK `(zone_id, cache_key)`, one row per
cache key per zone); the application data flow that produced this table
writes an entry once per fetch and is not known to update rows in place under
normal operation (no code path in this repo issues an `UPDATE
zone_weather_cache`; the presence of a live `updated_at DEFAULT
CURRENT_TIMESTAMP` column is boilerplate carried over from a generic
create/update template, not evidence of an update code path). Given that,
`created_at` (row-insertion time) is the closest live analogue to "when was
this cache entry fetched," so the rebuild maps `fetched_at <- created_at`.

**Mapping decision - dropping `updated_at`.** If the table truly is
insert-only, `updated_at` never diverges from `created_at` and carries zero
additional information; dropping it loses nothing. If it turns out some row's
`updated_at` DOES differ from its `created_at` (evidence of an actual update
event this design didn't anticipate), that value is real drift information
this rebuild would otherwise silently discard - so **the generated artifact's
`apply()` refuses to rebuild `zone_weather_cache` if any row has `updated_at
<> created_at`**, rather than assuming its own row-lifecycle argument holds.
Audited: table has 0 rows on this copy, so the guard trivially passes today;
it exists for whatever state the table is in on the day the real window runs.

**Orphan guard required**: `apply()` preflights
`SELECT COUNT(*) FROM zone_weather_cache WHERE zone_id NOT IN (SELECT id FROM irrigation_zones)`
and refuses if nonzero. Audited: 0/0.

**NULL guard required**: `apply()` preflights `expires_at IS NULL` and refuses
if nonzero. Audited: 0/0.

## 4. Ordering and the FK fence

**Devices must be rebuilt before device_data**, in the same transaction, with
`PRAGMA foreign_keys=OFF` held across the ENTIRE transaction (not toggled
per-table). This is not optional and not merely an optimization:

`devices` has 5 declared FK children in reference(1), all `ON DELETE CASCADE`:
`device_data`, `dendrometer_readings`, `dendro_baselines`,
`weather_station_zones`, `chameleon_readings`. If `devices` were dropped while
`PRAGMA foreign_keys=ON`, SQLite would cascade-delete every matching row in
all 5 child tables the instant the `DROP TABLE devices` statement ran -
silently wiping 69,686 `device_data` rows (and whatever the other 4 tables
hold) as a side effect of fixing a CHECK constraint. This is the exact,
previously-realized incident class documented in
`docs/operations/edge-history-retention.md`, and it is why the sanctioned
`sync-init-fn` boot-node `devices` rebuild (see `osi-schema-change-control`
skill, "Boot-DDL freeze" section) brackets its own rebuild in
`PRAGMA foreign_keys=OFF` / `...=ON` around the whole transaction, never
per-statement.

Concretely, the generated artifact (`scripts/ops/uganda-schema-rebuild-20260911.sql`)
is structured as:

```sql
PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;
BEGIN IMMEDIATE;
  -- devices (rebuild)
  -- device_data (rebuild; its new FK declaration resolves against the
  --              already-rebuilt `devices`, since it runs second)
  -- irrigation_events (ALTER ADD COLUMN + CREATE UNIQUE INDEX)
  -- valve_actuation_expectations (rebuild)
  -- zone_irrigation_calibration (rebuild)
  -- zone_weather_cache (rebuild)
COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA legacy_alter_table = OFF;
```

`PRAGMA foreign_keys` is a documented SQLite no-op when issued inside an
already-open transaction, so both toggles are OUTSIDE `BEGIN`/`COMMIT` -
exactly the `composeDestructiveScript()` pattern in
`lib/osi-migrate/runner.js` for `destructive`-class ordered migrations.

**`PRAGMA legacy_alter_table = ON` is a second, independently-required
toggle, not a foreign_keys duplicate.** Empirically discovered while building
the rehearsal fixture for this design (reproduced in
`scripts/ops/generate-uganda-schema-rebuild-20260911.test.js`): with
`legacy_alter_table` at its modern default (`OFF`), executing `ALTER TABLE
devices_rebuild_20260911 RENAME TO devices` inside this transaction raises
`error in trigger trg_dp_device_data_outbox_ai: no such table: main.devices`
- even though FK *enforcement* is already off. Modern SQLite's `ALTER TABLE
... RENAME` eagerly re-validates every other schema object that mentions the
renamed table's name (to rewrite references if the name actually changed),
and that eager pass trips over the transient instant between `DROP TABLE
devices` and the rename completing, on a trigger (`device_data`'s own) that
merely *mentions* `devices` in a subquery - not because the FK is enforced,
but because of a stricter (and here, spurious, since the table's final name
`devices` is unchanged from before this transaction started) schema-
consistency check. `legacy_alter_table = ON` reverts `ALTER TABLE RENAME` to
its pre-3.25 behavior (a raw catalog rename, no dependent-object
re-validation/rewrite pass), which is sufficient here because nothing in
this artifact's column mappings depends on that rewrite (no other table's
trigger/view/FK text references any of the 6 rebuilt tables' STAGING names,
only their final names, which never change). This is the same pairing the
sanctioned `sync-init-fn` boot-node `devices` rebuild uses (see
`osi-schema-change-control` skill, "Boot-DDL freeze": "`PRAGMA
foreign_keys=ON` (and `legacy_alter_table=OFF`) are restored in a `finally`
block").

After `COMMIT` and both PRAGMA restores, `apply()` runs `PRAGMA
integrity_check` and `PRAGMA foreign_key_check` and refuses to report success
if either fails (the latter would catch, among other things, a mapping bug
that let an orphan slip past the preflight guards).

The other 4 tables (`irrigation_events`, `valve_actuation_expectations`,
`zone_irrigation_calibration`, `zone_weather_cache`) have no FK relationship
to `devices`/`device_data` or to each other, so their relative order inside
the transaction does not matter for correctness; the artifact runs them after
the `devices`/`device_data` pair for readability only.

## 5. Idempotency and the drift-signature guard

`generate-uganda-schema-rebuild-20260911.js --apply <db>` is safe to re-run:

1. **Drift-signature preflight.** Before touching anything, it re-runs
   `semantic-schema-compare` against a freshly-built reference(1) and compares
   the live DB's failing diffs to the EXACT 17-key set above. Any diff outside
   that set (an unexpected table already dropped, unrelated drift picked up
   since the audit, a `--version`-mismatched checkout) causes a hard refusal
   with the unexpected diff(s) printed - it never guesses or partially
   applies. A live DB with FEWER than 17 (some tables already fixed, e.g. a
   partial prior run) is accepted - that is exactly the next guard's job.
2. **Per-table already-canonical skip.** For each of the 6 tables, it compares
   the live `sqlite_master.sql` against reference(1)'s (normalized) and skips
   that table's block entirely if they already match - logged, not silent.
3. **Per-table data preflights** (§3.2, §3.5, §3.6) run immediately before
   that table's block, on live data, every time - not just on first run. A
   second run against an already-rebuilt DB has nothing left to preflight
   (every table skips at step 2) and is a no-op.
4. **Postflight**: `PRAGMA integrity_check` = `ok` and `PRAGMA
   foreign_key_check` = zero rows are asserted after every real run (not
   skipped runs).

`--dry-run <db>` runs the drift-signature preflight and, per table, reports
SKIP / REFUSE(reason) / REBUILD without executing any DDL - the reviewer- and
operator-facing "what would happen" command.

`--verify <db>` re-runs `semantic-schema-compare` scoped to the 6 tables and
reports PASS/FAIL - the same acceptance bar as §7 below, callable
independently of `apply()`.

## 6. Orphan-handling policy (recommendation)

Two options were considered for any of the three orphan/NULL classes above
(device_data->devices, zone_weather_cache->irrigation_zones,
zone_irrigation_calibration/valve_actuation_expectations NOT NULL columns):

- **(a) Quarantine to a `_legacy` table** - move offending rows aside, rebuild
  cleanly, let an operator triage the quarantine table later.
- **(b) Refuse and hold** - do not run that table's rebuild at all if any
  orphan/NULL-violation is found; require a human decision (fix the data or
  explicitly accept a quarantine) before re-running.

**Recommendation: (b), refuse and hold**, and that is what the generated
artifact implements. Rationale, grounded in the audit numbers: every count in
§2.1/§3 is currently **zero**. There is no known-real orphan or NULL-violation
population to quarantine today - a quarantine mechanism would be untested
dead code shipped for a hypothetical. If the real on-device audit (re-run
immediately before the actual window, per §8) finds a nonzero count, that is
itself new information serious enough to warrant a human decision (why does
Uganda have `device_data` rows with no owning `devices` row? that smells like
a different bug, not a rebuild-artifact detail) rather than an automatic,
unreviewed quarantine. (a) remains available as a follow-up design if a real
nonzero count is ever found - deliberately not built now, to avoid shipping
an untested code path for a scenario the audit shows does not currently
exist.

## 7. Acceptance criterion (Definition of Done for a real run)

The rebuild artifact succeeded if and only if, after `apply()`:

1. Row counts for all 6 tables are identical to before, except explicitly
   quarantined rows (none anticipated per §6 - if the drift-signature or data
   preflights ever refuse, ZERO tables are touched, not a partial subset).
2. `PRAGMA integrity_check` returns `ok`.
3. `PRAGMA foreign_key_check` returns zero rows.
4. `node scripts/ops/generate-uganda-schema-rebuild-20260911.js --verify <db>`
   reports PASS (all 6 tables match reference(1)).
5. **`node scripts/baseline-existing-db.js <db> --report` reports N=1 as a
   passing candidate** (not just best-scoring) - i.e. `matched` is no longer
   `null`. This is the actual G4 gate the whole rehearsal exists to clear;
   §9 shows this held end-to-end in the local rehearsal.
6. `node scripts/migrate-cli.js <db> --backup-dir <dir>` then reaches head
   (currently migration 53) and `node scripts/verify-head-cli.js <db>` reports
   `ok: true`.

## 8. Transaction/PRAGMA plan, disk headroom, and rollback

**Transaction plan**: one transaction for all 6 tables' DDL (§4). Backups are
taken BEFORE this transaction starts (see below), not inside it - table
rebuilds copy every row of `device_data` (69,686 rows currently; grows daily),
so the transaction should be as short as achievable, and a backup taken mid-
transaction would be inconsistent anyway.

**Disk headroom**: worst case, the rebuild transiently holds both the old and
new copy of every table being rebuilt at once (old `device_data` + new
`device_data_rebuild_20260911` coexist between the `INSERT ... SELECT` and the
`DROP TABLE`). `device_data` is by far the largest table in scope; the whole
DB is 54,120,448 bytes (54 MB) uncompressed. A conservative 2x-worst-case
headroom requirement is therefore ~108 MB, i.e. roughly 2x the WHOLE
database's current size, not just `device_data`'s share of it (SQLite does not
expose easy per-table byte sizes without a full `dbstat` scan, and 2x the
whole file is already a safe, simple-to-state upper bound). Uganda's gateway
has 3.3 GB free (per the brief's stated known fact) - more than 30x the
required headroom. `deploy.sh`'s existing disk-preflight gate (already run
ahead of any schema migration) covers this in the real on-device window; this
design does not introduce a new disk-check mechanism, it just confirms the
existing one has enormous margin here.

**Rollback**: migrate-cli-style byte-image restore, NOT a SQL rollback inside
the transaction (a mid-transaction SQL error already rolls back for free via
`ROLLBACK` semantics - that is not the interesting failure mode). The
interesting failure mode is "the transaction committed, but postflight
(`integrity_check`/`foreign_key_check`) failed" or "a later step in the window
(`baseline-existing-db.js`, `migrate-cli.js`) failed after this artifact
already committed." For that: the on-device window script (§10) takes a
`.backup`-based, integrity-checked on-device backup BEFORE this artifact runs
(same pattern `uganda-catchup-window.sh` already uses ahead of the catch-up
artifact), and `migrate-cli.js`'s own persistent pre-migration backup +
byte-image restore (already proven end-to-end in the original rehearsal's
"Restore-path + migrate-cli mechanics" section) covers everything from
`baseline-existing-db.js`'s stamp onward. If THIS artifact's own postflight
fails, the window script's `fail()` path fires, Node-RED is restarted (exit
trap), and the operator restores from the pre-artifact on-device backup - the
same manual-restore contract the window script already documents for every
other failure branch. No new rollback mechanism is introduced; this design
reuses the two that already exist and are already rehearsed.

## 9. What was actually rehearsed (evidence pointers)

See `docs/operations/uganda-catchup-rehearsal-20260911-report.md`'s rebuild
addendum for the full command transcript and log files. Summary: the
end-to-end test in `scripts/ops/generate-uganda-schema-rebuild-20260911.test.js`
(`'apply() end-to-end: catch-up artifact -> rebuild artifact ->
repair-sync-outbox-v2 -> baseline-existing-db stamps N=1 -> migrate-cli
reaches head -> verify-head ok'`) proves the full pipeline on a fixture built
from the real, unmodified migration 0001 DDL, deliberately drifted to
reproduce the exact 17-diff shape audited on the real Uganda copy. Separately,
`scripts/ops/uganda-schema-audit.js` and
`scripts/ops/generate-uganda-schema-rebuild-20260911.js --dry-run` were run
directly against a local byte-copy of the real Uganda backup (never a live
DB) to confirm the drift-signature guard accepts real Uganda data and the
audit numbers in §2 are accurate.

## 10. What this design does NOT do

- It does not touch `lib/osi-migrate`, `database/migrations/ordered/`,
  `database/seed-blank.sql`, or `CHECKSUMS.json`. It is not an ordered
  migration - these 6 tables' pre-ledger drift predates the migration ledger
  entirely (the same rationale `repair-sync-outbox-v2.js` documents for
  `sync_outbox`'s v2 columns: "no migration slot can express 'add them to a
  pre-ledger DB'"). Once Uganda is baselined at N=1 by `baseline-existing-db.js`
  and carried to head by `migrate-cli.js`, this tool's job is permanently done
  for Uganda; it is not a repeatable maintenance script for the fleet (unlike
  `repair-sync-outbox-v2.js`, which any other pre-ledger gateway might still
  need).
- It does not run on a live device. That is the on-device window's job
  (§ below, and the updated `scripts/ops/uganda-catchup-window.sh`), which
  requires a SEPARATE, explicit go-ahead after this design's adversarial
  review clears.
- It does not decide the sync-outbox trigger literal issue (the hardcoded
  Silvan EUI fallback `'0016C001F11715E2'` visible in the generated artifact's
  `trg_sync_devices_defaults_ai`/`trg_dp_device_data_outbox_ai` bodies above) -
  that is pre-existing, sourced verbatim from reference(1) exactly as the
  catch-up artifact already does, and already analyzed in the original
  rehearsal report ("Boot-node / Node-RED verification" section): it is
  corrected transiently by `sync-init-fn` rewriting all boot statements with
  the real `DEVICE_EUI` on every Node-RED start, which is why the on-device
  window restarts Node-RED on every exit path.
