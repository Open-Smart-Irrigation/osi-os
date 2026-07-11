---
name: osi-schema-change-control
description: Use when adding/changing a SQLite table, column, index, trigger, or view on the OSI OS edge; editing seed-blank.sql or a bundled farming.db; writing database/migrations/ordered/NNNN__slug.sql; touching lib/osi-migrate; a migration verifier fails (verify-migrations, verify-seed-replay, verify-runtime-schema-parity, verify-db-schema-consistency, verify-devices-rebuild-fence); schema_object_fingerprints drift; or touching the frozen sync-init-fn boot node.
---

# OSI Schema Change Control

## Overview

OSI OS edge state lives in one SQLite file per gateway, `/data/db/farming.db`. This
file survives for the operational life of a Pi and cannot be safely reseeded —
farm history (irrigation events, sensor readings, dendrometer calibration) is
irreplaceable. Because of that, edge SQLite schema is under change control, not
free-form DDL.

As of 2026-07-10 there are two overlapping mechanisms with different scopes:

1. **The ordered migration runner** (`lib/osi-migrate` + `database/migrations/ordered/`) —
   the *governed, executable schema authority* per
   `docs/adr/2026-06-30-schema-and-contract-ownership.md`. CI verifies it, and
   `deploy.sh` now fetches and runs it at deploy time through
   `run_schema_migration()`; it still does not run from the Node-RED boot path.
2. **The Node-RED boot node `sync-init-fn`** ("Sync Init Schema + Triggers") — a
   legacy inline-DDL block that runs on every boot on every live Pi. It is FROZEN
   for new schema behavior (one narrow, sanctioned exception below).

Both must stay in fingerprint/column parity with `database/seed-blank.sql`, which
is the schema source of truth for a fresh database. Getting any of this wrong on a
live Pi is a farm-data-loss incident, not a bug.

## When to use

- Adding/removing/renaming a table, column, index, trigger, or view anywhere edge
  SQLite touches (`database/seed-blank.sql`, bundled `farming.db` copies,
  `database/migrations/ordered/`, or the boot node).
- Writing a new `database/migrations/ordered/NNNN__slug.sql` file and choosing its
  risk class.
- A migration/parity verifier is red: `verify-migrations.js`,
  `verify-seed-replay.js`, `verify-runtime-schema-parity.js`,
  `verify-db-schema-consistency.js`, `verify-devices-rebuild-fence.js`,
  `rehearse-devices-rebuild.test.js`.
- `schema_object_fingerprints` drift, a `repair_required` row in
  `schema_migrations`, or a "checksum mismatch" error from the runner.
- Any proposed edit to the `sync-init-fn` boot node's DDL/rebuild logic.
- Deciding whether a device-type or column addition needs a `devices.type_id`
  CHECK rebuild.

## When NOT to use — route to the sibling skill

| Situation | Use instead |
|---|---|
| "duplicate column" or other verifier failure and you haven't yet found the root cause | `osi-debugging-playbook` (symptom triage) first, then come back here once you know it's a schema-ownership question |
| Deploying to a live/provisioned Pi, running the on-device restamp recovery (`scripts/restamp-fingerprints.js`) during an incident, or any live-Pi repair procedure | `osi-live-ops-runbook` |
| Mechanics of how to script-edit `flows.json` safely (parse/mutate/verify round-trip) | `osi-flows-json-editing` — this skill tells you *what* schema change is allowed in `sync-init-fn`, that skill tells you *how* to make the JSON edit |
| Sensor/device domain semantics (what a column means agronomically, SWT canonicalization, calibration math) | `osi-agronomy-sensors-reference` |
| Env vars, UCI flags, deploy-time knobs unrelated to schema | `osi-config-and-flags` |

This skill never routes around change control: it does not grant permission to
hand-edit ledger tables, reseed a live DB, or add schema behavior to the boot node
outside the one sanctioned exception.

## NEVER-do list

| Never | Why |
|---|---|
| Hand-edit `schema_object_fingerprints` | It is a computed baseline (SHA-256 over live DDL + `PRAGMA table_xinfo`/`foreign_key_list`/`index_list`/`index_xinfo`). A hand edit desyncs the stamp from the real schema and the next `applyPending` either falsely passes or falsely refuses. The only sanctioned re-baselines are `scripts/restamp-fingerprints.js` (recompute fingerprints of a confirmed-good live schema) and `scripts/baseline-existing-db.js` (semantic-gated first baseline of a pre-ledger device — Option B Stage 0, spec 2026-07-07). |
| Reseed or overwrite `/data/db/farming.db` on a provisioned Pi | `deploy.sh`'s `seed_db_if_missing` only seeds when the file is absent *and* no WAL/SHM/journal sidecars exist; it refuses otherwise. Overwriting destroys irreplaceable farm history. |
| Add new schema behavior to `sync-init-fn` (the boot node) | It is FROZEN (AGENTS.md "Boot-DDL freeze"). New schema goes through the migration runner's ordered files and deploy-time runner path, not boot-time inline DDL. |
| Modify an already-merged `database/migrations/ordered/NNNN__slug.sql` file | Migrations are checksummed (SHA-256 of the raw file bytes, `lib/osi-migrate/migrations-loader.js`). Changing a merged file makes the ledger's stored checksum mismatch the file on next apply, which the runner treats as `repair_required` and refuses to proceed past. |
| Update `seed-blank.sql` or one bundled DB without the others | `verify-seed-replay.js` and `verify-db-schema-consistency.js` both fail if any of the 7 bundled copies drifts from the seed/migration-replay schema. One home for the fact: keep all copies byte/fingerprint-identical in the same commit. |
| Rebuild a parent table (drop/rename swap) without the FK fence | Without `PRAGMA foreign_keys=OFF` held across the swap, `ON DELETE CASCADE` on child tables (`device_data`, `chameleon_readings`) silently wipes their rows when the parent is dropped. This caused a documented field history-loss incident (`docs/operations/edge-history-retention.md`). |
| Run a `destructive`-class migration without writers stopped | `runner.js` enforces this in code — it throws `refuse to run unless writers are stopped (deploy/pre-start)` — because a table rebuild racing a live Node-RED writer can corrupt or lose in-flight rows. |

## Decision table: which mechanism do I use?

| Change | Mechanism | Notes |
|---|---|---|
| New table, column, index, view, or trigger (append-only) | New `additive` ordered migration + `seed-blank.sql` + all 7 bundled DBs | No backup, no writers-stopped gate required by the runner itself, but you still must keep parity surfaces in sync (see Walkthrough). Already-provisioned Pis receive it through `deploy.sh` `run_schema_migration()`. |
| Drop/rename/rebuild a table, or alter a CHECK/constraint that SQLite can't `ALTER` in place | New `destructive` ordered migration | Requires `writersStopped=true`; FK fence in the migration. `deploy.sh` stops Node-RED, checkpoints WAL, and invokes `scripts/migrate-cli.js` with a persistent pre-migration backup under `/data/backups/migrate`; do not invent an ad hoc path. |
| Backfill / data correction against existing rows | New `data` ordered migration | Persistent backup + normal transaction; no FK fence; must be idempotent against the pre-migration row shape. Deploy-time delivery uses the same `run_schema_migration()` path. |
| `devices.type_id` CHECK needs a new device type on a **live** Pi today | The guarded fail-closed rebuild already shipped in `sync-init-fn` (sanctioned exception) + `scripts/repair-pi-schema.js` entry | Do not add a second rebuild path; extend the existing `REQUIRED_TYPES` set and its parity surfaces (`verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js`) — subject to the full boot-node merge gate below (four verifiers + production-copy rehearsal). |
| Idempotent additive repair needed on live Pis at deploy time (e.g. a new column) | New ordered migration delivered by `deploy.sh` `run_schema_migration()` | Do not add `ensure_*` functions. The deploy runner fetches `CHECKSUMS.json`, all ordered migrations, Stage 0 baseline helpers, and `lib/osi-migrate`, then applies pending migrations once writers are stopped. |
| Any other on-device schema mutation | Ordered migration runner path, or no change | If the runner cannot express it safely, stop and design the schema project first; do not add inline DDL to `deploy.sh`, `flows.json`, or init scripts. |

## The model: ownership, migrations, risk classes

### Ownership (ADR 2026-06-30)

`docs/adr/2026-06-30-schema-and-contract-ownership.md` (Accepted, 2026-06-30) sets
a hard three-layer boundary:

1. **Edge SQLite DDL is owned by osi-os ordered migrations + a ledger** — the
   *only* executable schema authority on the edge. Migrations are versioned,
   idempotent, checksummed, transactional where possible, applied exactly once,
   recorded in a `schema_migrations` ledger.
2. **Cloud Postgres DDL is owned by osi-server Flyway**, independently — the two
   databases differ on booleans, timestamps, CHECK handling, trigger languages,
   FK enforcement, and JSON storage and are not forced into one shared model.
3. **Cross-repo compatibility is owned by versioned sync event/payload schemas**,
   not shared DDL — extending `docs/contracts/sync-schema/`.

The ADR rejected a single YAML DSL generating SQLite DDL, Flyway migrations, Java
entities, TypeScript types, and channel manifests from one model: the cross-dialect
gap plus the need for imperative, order-sensitive migration logic (table rebuilds,
FK fences, backfills, partial-failure recovery) made a declarative final-state
generator unsafe for a live production edge DB. (The draft it supersedes,
`docs/superpowers/specs/2026-06-30-schema-driven-codegen-design.md`, is referenced
by the ADR but was never committed to the repo — do not go looking for it.)

### Ordered migrations: format and risk-class declaration

Files live at `database/migrations/ordered/NNNN__slug.sql` — currently
`0001__baseline.sql` through `0007__analysis_views.sql`. The filename format is
enforced by a regex in `lib/osi-migrate/migrations-loader.js`:
`^(\d{4})__([a-z0-9_]+)\.sql$` — four-digit version, double underscore, lowercase
slug. Versions must be unique and are sorted numerically, not lexically.

**The risk class is declared in a mandatory file header, not inferred from
content or filename.** `migrations-loader.js` requires the first non-blank line
(a UTF-8 BOM and leading blank lines are tolerated) to match
`-- risk: additive|destructive|data`. A migration missing this header throws
`migration <file> missing '-- risk: additive|destructive|data' header` and is
rejected before it can run. Example, verbatim from `0002__gateway_health.sql`:

```sql
-- risk: additive
-- 0002: Persist aggregated gateway CPU health reporting (osi-os issue #68).
```

Each migration file is also SHA-256 checksummed over its **raw bytes**
(`crypto.createHash('sha256').update(raw)` in `migrations-loader.js`) and that
checksum is stored in the `schema_migrations` ledger row on success. If a
previously-applied migration's on-disk checksum no longer matches the stored one,
`applyPending` marks it `repair_required` and throws — this is the enforcement
mechanism behind "never modify a merged migration."

### Risk-class semantics, verified against `lib/osi-migrate/runner.js`

- **`additive`** — append-only schema (new tables/columns/indexes/views/triggers).
  No backup is taken. No transaction fence: it runs as a plain
  `BEGIN IMMEDIATE; <sql>; <ledger insert>; COMMIT;` block (see the final `else`
  branch of the risk dispatch in `applyPending`).
- **`destructive`** — schema mutation (drop/rename/rebuild/alter). The runner
  refuses to even start unless the caller passed `writersStopped: true` (deploy
  pre-start), throwing `migration <name> is destructive; refuse to run unless
  writers are stopped (deploy/pre-start)` otherwise. It takes an online backup
  first (`backupDb`), then runs `composeDestructiveScript`, which toggles
  `PRAGMA foreign_keys` **outside** the transaction (SQLite treats
  `PRAGMA foreign_keys` as a no-op inside an open transaction, so it must bracket
  it) and fences the actual DDL inside `BEGIN IMMEDIATE`/`COMMIT` between the
  `OFF`/`ON` toggle: `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; <sql>; <ledger
  insert>; COMMIT; PRAGMA foreign_keys=ON;`.
- **`data`** — backfill/mutation of existing rows. Takes an online backup (same
  as destructive), then applies in a normal transaction — `BEGIN IMMEDIATE; <sql>;
  <ledger insert>; COMMIT;` — with **no** FK toggle and **no** writers-stopped
  gate. The code comment in `runner.js` is explicit: "Write data migrations
  idempotently vs the old format." Data migrations are meant to run at deploy
  time specifically because a long-running backfill would otherwise hold the
  write lock past the Node-RED runtime's busy timeout (5 s, `PRAGMA
  busy_timeout=5000` in `osi-db-helper`; the CLI runner itself uses a 30 s
  `.timeout`) if it ran during normal operation.

All three classes run `postflight` after commit: `PRAGMA integrity_check` must
return `ok`, and `PRAGMA foreign_key_check` must return zero rows, or the
migration is treated as failed even though its DDL already committed (see
"mid-batch failure" below).

**Per-migration fingerprint stamping.** After each migration's transaction
commits, `applyPending` calls `syncFingerprints` for *that migration alone*,
before attempting the next one in the batch — this is outside the `try`/`catch`
on purpose (a stamp failure must not retroactively mark an otherwise-successful
migration `repair_required`). This means a batch of N migrations that fails on
migration k leaves migrations `1..k-1` correctly stamped; the retry's drift
preflight (see below) then sees a consistent world and does not spuriously wedge
the whole batch. Before this was added, a mid-batch failure could leave the
fingerprint baseline representing "nothing applied" while the DB already had
`1..k-1` committed, which the next run's drift check would reject as corruption
rather than progress.

**Preflight drift check.** Before applying anything, `applyPending` recomputes
live fingerprints and compares them to the stored baseline; if they differ it
refuses with `schema drift detected before applying migrations ... Refuse to
proceed`, pointing at `restamp-fingerprints.js` as the recovery path if the live
schema is known-good.

**Backup retention.** `lib/osi-migrate/backup.js`'s `backupDb` takes an online
backup via the `sqlite3` CLI's `.backup` dot-command (safe under an active WAL),
verifies the copy's `PRAGMA integrity_check`, then calls `pruneBackups(dbPath,
keep=5)` — ISO-timestamped `<db>.bak-<stamp>` files are sorted lexically
(equivalent to chronologically) and all but the newest 5 are deleted. Pruning is
per-file resilient (one un-removable sibling logs and continues) and the whole
prune step is wrapped so a directory-level failure never fails an
already-integrity-checked backup.

### Key fact: deploy-time runner, not boot-time runner

`deploy.sh` is now the on-device delivery path for ordered migrations. Its
`run_schema_migration()` function fetches `CHECKSUMS.json`, every ordered
migration named by that manifest, `scripts/migrate-cli.js`,
`scripts/baseline-existing-db.js`, `scripts/repair-sync-outbox-v2.js`,
`scripts/semantic-schema-compare.js`, and the required `lib/osi-migrate` modules.
It ensures the `sqlite3` CLI is present, attempting `opkg install sqlite3-cli`
before refusing. It then stops Node-RED, waits up to 30 seconds for the process to
exit, checkpoints WAL, inspects `schema_migrations`, performs the temporary
pre-baseline `sync_outbox` v2-column repair and semantic baseline only when the
DB has no ledger rows yet, and calls `migrate-cli.js` with `--backup-dir
/data/backups/migrate`.

That is still **not** a boot-time path. `flows.json`, the Node-RED init script,
and `sync-init-fn` must not call `applyPending` or grow new schema behavior.
Boot remains limited to the frozen legacy node plus the already-sanctioned
devices-CHECK safety exception.

## Boot-DDL freeze (the other schema path, and why it's frozen)

The Node-RED node **"Sync Init Schema + Triggers"** (node id `sync-init-fn`,
present byte-identically in both
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` and the
`bcm2709` mirror) performs inline DDL on every boot: verified count is **93**
`ADD COLUMN` statements in the function body, the large majority idempotent
against a schema that already has the column (errors from these are swallowed in
a `try {...} catch (_) {}` sweep). This node is **FROZEN**: do not add new schema
behavior to it. New schema changes go through the ordered-migration runner's
files and the deploy-time runner path. That freeze is the reason the migration
runner cutover stays tractable.

### Incident history (one line each, factual)

- **PR #79** restored the `devices.type_id` CHECK list plus a runtime↔seed parity
  guard after the boot rebuild had silently recreated `devices` with the CHECK
  missing `AQUASCOPE_LORAIN` on every restart (fixed in `a646efe3`).
- **Issue #84 / "duplicate column" verifier failures**: recurring `duplicate
  column` errors were, in writing, blamed on the boot DDL node. The real root
  cause was a stale upgrade-test baseline — the misattribution itself had to be
  corrected (`docs/superpowers/plans/2026-07-04-fix-history-schema-upgrade-baseline.md`).
  Lesson embedded in the playbook (`docs/engineering-playbook.md` §6): "a signal
  that pattern-matches a known failure may have a different cause."
- **PR #86 (2026-07)** shipped the guarded, fail-closed `devices` table rebuild —
  the one sanctioned exception to the freeze, because it is a safety fix rather
  than new schema behavior. Details below.

### The sanctioned exception: guarded fail-closed `devices` rebuild

Verified directly in `sync-init-fn`'s function body (both flows files, byte
identical). The rebuild:

1. Reads the live `devices` table's CHECK clause and extracts the current
   `type_id` set with a regex.
2. Compares it by **set equality** against the six canonical types —
   `KIWI_SENSOR`, `STREGA_VALVE`, `DRAGINO_LSN50`, `TEKTELIC_CLOVER`,
   `SENSECAP_S2120`, `AQUASCOPE_LORAIN` (named `REQUIRED_TYPES` in the code). If
   the live set is missing a type *or* has an extra/drifted type, `needsRebuild`
   is true — this is stricter than "missing-only," which was a P2 review finding
   fixed before merge (an extra drifted type must also trigger convergence, not
   just an omission).
3. Only if a rebuild is needed: `PRAGMA foreign_keys=OFF`, then inside
   `_db.transaction(...)` — one `operationQueue` slot, `BEGIN IMMEDIATE`,
   auto-`ROLLBACK` on any throw — it drops any stale `devices_new` left from a
   prior crash, creates `devices_new` with the corrected CHECK, copies rows with
   a **plain `INSERT`** (not `INSERT OR IGNORE`), drops `devices_old` if present,
   renames `devices`→`devices_old`→drop, renames `devices_new`→`devices`, and
   recreates the four `devices` indexes. Because the copy is a plain `INSERT`,
   any row that violates the new CHECK throws inside the transaction and rolls
   back the whole rebuild — `devices` is left untouched, not silently missing
   rows. This replaces the old `INSERT OR IGNORE` behavior, exactly the class of
   bug that caused the AQUASCOPE_LORAIN regression above.
4. `PRAGMA foreign_keys=ON` (and `legacy_alter_table=OFF`) are restored in a
   `finally` block that guards each restore independently, so one failing
   restore can't skip the other, on **every** exit path including a caught
   rebuild error. Errors are surfaced via `node.error('devices rebuild ABORTED
   (devices left intact): ' + e.message)` — never swallowed silently, unlike the
   ~93 ADD COLUMN sweep above it in the same function.

**FK fence rationale:** rebuilding a parent table via a drop/rename swap without
`PRAGMA foreign_keys=OFF` held across the swap lets `ON DELETE CASCADE` on child
tables (`device_data`, `chameleon_readings`) fire the moment the old `devices` is
dropped, silently wiping those child rows. This is the documented cause of a real
field history-loss incident (`docs/operations/edge-history-retention.md`); the
fence is what prevents it from recurring.

### Merge gate for any further touch to this block

Verified present and passing in this worktree on 2026-07-06:

```
node scripts/verify-runtime-schema-parity.js     # OK (2 flows: devices CHECK + trigger parity)
node scripts/verify-profile-parity.js            # All parity checks passed.
node scripts/verify-devices-rebuild-fence.js     # OK (2 flows)
node --test scripts/rehearse-devices-rebuild.test.js   # 4/4 pass
```

`rehearse-devices-rebuild.js` executes the **actual shipped function text**
(via `new Function('osiDb','env','node','msg', funcText())`) against a
facade-compatible shim over Node's built-in `node:sqlite` (`DatabaseSync`) — a
real engine, not a fake — across four seeded cases: `healthy` (guard must skip,
rows preserved), `would-drop` (a row the new CHECK would reject must never be
silently dropped, and the abort must be surfaced), `legit-upgrade` (rebuild
succeeds, CHECK gains `AQUASCOPE_LORAIN`), and `extra-type` (a drifted extra type
with no offending rows must still trigger a rebuild that converges the CHECK back
to exactly the six canonical types). `verify-devices-rebuild-fence.js` statically
greps both flows files for the fail-closed shape: no `INSERT OR IGNORE INTO
devices_new`, rebuild inside `_db.transaction(`, guarded by
`REQUIRED_TYPES`/`needsRebuild`, `finally` before `foreign_keys=ON`, a
`DROP TABLE IF EXISTS devices_new` pre-clean, and — a Node-RED-specific
deadlock hazard — no `_db.*` calls (only `t.*`) inside the transaction executor
(a facade-level `_db.*` call from inside an open transaction deadlocks on-device,
a separate `operationQueue` slot waiting on the in-flight transaction).

Three of the four are wired into `.github/workflows/migrations.yml`
(`verify-runtime-schema-parity.js`, `verify-devices-rebuild-fence.js`, and the
rehearse test); `verify-profile-parity.js` is CI-gated via the
`verify-sync-flow.yml` workflow (chained from `verify-sync-flow.js`). A
production-copy rehearsal is additionally expected before rollout to a live
gateway (see `osi-live-ops-runbook` for the actual on-Pi procedure).

**Additional gate:** `scripts/verify-sync-flow.js` is green on `main` (verified
in this worktree 2026-07-06, exit 0) and CI-gated by its own workflow,
`.github/workflows/verify-sync-flow.yml` — separate from `migrations.yml`. It
chains `verify-db-schema-consistency.js` and `verify-profile-parity.js`: a full
run prints `Sync flow verification passed` at the end of the sync section and
terminates with `All parity checks passed.`. (An older plan document described it as RED at baseline; that was the
stale upgrade-test baseline fixed via the issue #84 pin — treat any RED result
today as a real regression, not a known baseline.)

## Parity surfaces

`database/seed-blank.sql` is the schema source of truth for a **fresh** database.
It must stay in parity with every bundled `farming.db` copy. As of 2026-07-06,
`find . -name farming.db -not -path '*/node_modules/*'` returns exactly 7 files:

```
conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db
conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
database/farming.db
web/react-gui/farming.db
```

(Note: this is broader than just the two `full_*` bcm2712/bcm2709 shipping
profiles — it also includes the `base_*` profiles and the legacy `bcm2708`
directory, plus the two dev-convenience copies under `database/` and
`web/react-gui/`. All 7 are covered by `verify-db-schema-consistency.js`.)

Four verifiers each check a different slice, all confirmed green in this
worktree on 2026-07-06:

| Verifier | What it checks | Run output |
|---|---|---|
| `scripts/verify-migrations.js` | Every ordered migration file is well-formed; versions contiguous from `0001` | `verify-migrations: OK (2 migrations)` |
| `scripts/verify-seed-replay.js` | Replays `bootstrapFresh` over the ordered migrations into a scratch DB and diffs its computed fingerprints (tables/indexes/triggers, excluding the ledger's own bookkeeping tables) against fingerprints from `seed-blank.sql` applied fresh — keeps the migration set and seed honestly equivalent | `verify-seed-replay: OK` |
| `scripts/verify-runtime-schema-parity.js` | Compares `sync-init-fn`'s `devices_new` CHECK type-set and each flow file's whole trigger set (both profiles) against the canonical set derived from `seed-blank.sql` — fails if the boot node ever *downgrades* the seed | `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)` |
| `scripts/verify-db-schema-consistency.js` | Hand-maintained column/index/trigger-fragment contract checked against all 7 bundled DB copies (defaults to the 7-path list above; accepts explicit paths as CLI args), plus an `EXPLAIN QUERY PLAN` check that a history query actually uses `idx_device_data_deveui_recorded_at`. Widest and slowest-changing — must be hand-extended whenever the contract changes (see Walkthrough) | all 7 paths `OK`, then `DB schema consistency verification passed` |

Two related, non-schema-content parity checks this area depends on:
`scripts/verify-devices-rebuild-fence.js` + `node --test
scripts/rehearse-devices-rebuild.test.js` (covered under Boot-DDL freeze above),
and `scripts/verify-profile-parity.js` (byte-for-byte hash comparison of
canonical payload files, including `files/usr/share/db` and
`files/usr/share/flows.json`, between the `bcm2712` source-of-truth profile and
the `bcm2709` mirror — confirmed green here).

All of the above ran clean (exit 0) in this worktree on 2026-07-06 with no
working-tree changes as a side effect.

## `deploy.sh` migration runner

`deploy.sh` never reseeds a provisioned Pi (see NEVER-do list). For schema catchup
on an existing DB, it now uses one path: `run_schema_migration()`.

1. It fetches the ordered migration corpus from
   `database/migrations/ordered/CHECKSUMS.json` instead of carrying inline DDL.
2. It fetches the Stage 0 pre-baseline helpers and the required
   `lib/osi-migrate` modules into `$TMP_DIR`, so the on-device script runs the
   same ledgered code as CI.
3. It ensures the `sqlite3` CLI exists (`opkg install sqlite3-cli` if needed),
   stops Node-RED before any live DB write, chains its restart with the existing
   cleanup trap, waits up to 30 seconds for the process to exit, checkpoints WAL,
   inspects `schema_migrations`, and only on DBs with no ledger rows runs
   `repair-sync-outbox-v2.js` followed by `baseline-existing-db.js`. It
   checkpoints again, then invokes `migrate-cli.js`.
4. `migrate-cli.js` calls `applyPending(..., writersStopped: true)` and uses a
   persistent pre-migration byte-image backup directory:
   `/data/backups/migrate` (or `MIGRATE_BACKUP_DIR` if explicitly overridden).
5. If migration fails after a restoreable destructive/data backup, deploy exits
   after restarting Node-RED. If restore integrity itself fails (`migrate-cli`
   rc=3), deploy restores the cleanup trap and intentionally leaves Node-RED
   stopped for operator intervention.

**Boundary:** `deploy.sh` is the deploy-time migration runner path; it must stay
free of inline `CREATE TABLE` / `ALTER TABLE` / `DROP TRIGGER` schema snippets.
The actual live-deploy procedure (how to run `deploy.sh` against a specific Pi,
safely) is out of scope here — see `osi-live-ops-runbook`.

## Restamp rules

`scripts/restamp-fingerprints.js` and `scripts/baseline-existing-db.js` (Option B
Stage 0 — semantic-gated ledger baseline + fingerprint sync for pre-ledger
devices) are the **only** sanctioned ways to re-baseline
`schema_object_fingerprints`. `restamp-fingerprints.js` takes a DB path, refuses
if the path doesn't exist (specifically to avoid the `sqlite3` CLI silently
creating an empty file at a typoed path and "successfully" restamping that
instead), and calls `syncFingerprints` directly — recomputing live fingerprints
and replacing the whole `schema_object_fingerprints` table with them.

**When it applies:** only after a crash between a migration's schema commit and
its fingerprint stamp, where the live schema has been independently confirmed
correct (e.g. via `PRAGMA integrity_check` and a manual review of what the
migration was supposed to produce). It is a recovery verb for a known-safe state,
not a way to silence a real drift preflight failure. The actual on-Pi recovery
procedure/runbook for when and how to run this against a live gateway is owned by
`osi-live-ops-runbook`; this skill only states the rule of when the tool is
appropriate to reach for at all.

## Common mistakes

- **Assuming the migration runner runs on boot.** It runs during `deploy.sh`, not
  during Node-RED startup. A `destructive`/`data` migration will not run
  automatically on the next Pi boot.
- **Treating `sync-init-fn`'s 93 `ADD COLUMN`s as a template to copy.** Frozen
  legacy debt (81 redundant with the seed, per AGENTS.md), not a pattern to
  extend — new additive schema goes in an ordered migration, not ADD COLUMN #94.
- **Confusing "missing-only" with the actual guard semantics.** The `devices`
  rebuild guard is **set-equality**: an extra/drifted type must also trigger a
  rebuild-and-converge, not just a missing type. A weaker missing-only guard was
  a real P2 review finding caught before merge.
- **Blaming the boot DDL node for a "duplicate column" verifier failure without
  checking the test baseline first.** Issue #84 shows this exact misattribution
  happened and had to be corrected in writing.
- **Updating `seed-blank.sql` (or one bundled DB) without the rest.** The
  verifiers above will catch it, but catching it in CI after the fact is more
  expensive than doing the "apply to all 7 copies + mirror" step in one commit.
- **Hand-writing SQL against `schema_object_fingerprints` or
  `schema_migrations`.** Both are runner-owned bookkeeping tables
  (`lib/osi-migrate/ledger.js`, `ensureLedger`), not part of `seed-blank.sql` or
  the bundled DBs. Exactly two sanctioned tools write these tables outside the
  runner: `restamp-fingerprints.js` (fingerprints only) and
  `baseline-existing-db.js` (semantic-gated ledger baseline + fingerprints;
  Option B Stage 0). Hand-editing either table directly remains forbidden.
  (`scripts/repair-sync-outbox-v2.js` is a sanctioned, temporary pre-baseline
  additive repair — not a ledger tool; delete it once the fleet is baselined.)
- **Forgetting the FK fence direction/order.** `PRAGMA foreign_keys` is a no-op
  inside an already-open transaction — set it `OFF` *before* `BEGIN`, restore it
  `ON` in a `finally` so it fires even when the rebuild throws.

## Walkthrough: adding a column end-to-end

This is the additive case (new column/table/index/trigger). For a CHECK
change or table rebuild, everything below still applies but you are in
`destructive`-class territory (writers-stopped gate, FK fence) — do not attempt
that live without also reading `osi-live-ops-runbook`.

1. **Write the migration.** Create
   `database/migrations/ordered/0008__your_slug.sql` (next contiguous 4-digit
   version) with a `-- risk: additive` header as the first line, then your
   `CREATE TABLE`/`ALTER TABLE ... ADD COLUMN`/`CREATE INDEX`/`CREATE TRIGGER`
   statements. Prefer `IF NOT EXISTS` on object-creation statements (tables,
   indexes, triggers) so the file is safely re-runnable, matching the `0002`
   precedent. `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` in SQLite, but
   live-Pi delivery still goes through the ordered migration runner; do not add a
   deploy-time `ensure_*` duplicate-column wrapper.
2. **Update `database/seed-blank.sql`.** Append the equivalent DDL so a fresh
   database created from the seed ends up schema-identical to one built by
   replaying all ordered migrations. `verify-seed-replay.js` is the automatic
   check for this; don't skip manual review just because the verifier exists.
3. **Regenerate all 7 bundled `farming.db` copies.** Apply your new migration
   file to each of the six non-mirrored copies with the `sqlite3` CLI, then copy
   the `bcm2712` full profile's DB over the `bcm2709` mirror so profile parity
   stays byte-for-byte (this is the exact pattern used for `0002`):
   ```bash
   cd "$(git rev-parse --show-toplevel)" && for db in \
     conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
     conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
     conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
     conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
     database/farming.db \
     web/react-gui/farming.db
   do sqlite3 -bail "$db" < database/migrations/ordered/0008__your_slug.sql && echo "OK $db"; done \
     && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
           conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
     && echo "OK mirror copy"
   ```
4. **Extend `scripts/verify-db-schema-consistency.js`'s hand-maintained
   `schemaContract`** (and `requiredIndexes`/`requiredTriggerSqlFragments` if
   applicable) with the new column/table/index so this widest verifier actually
   enforces the new shape going forward — it does not infer the contract from
   the migration file.
5. **Add TypeScript types** in `web/react-gui/src/types/farming.ts` if the new
   column/table is GUI-visible.
6. **Live Pi delivery is deploy-runner delivery.** Do not add or extend
   `deploy.sh` `ensure_*` functions. `deploy.sh` fetches and runs the ordered
   migrations, so the migration file is the live repair path for already
   provisioned Pis.
7. **Run the verifier set** and confirm each prints its OK line:
   ```bash
   node scripts/verify-migrations.js
   node scripts/verify-seed-replay.js
   node scripts/verify-runtime-schema-parity.js
   node scripts/verify-db-schema-consistency.js
   node scripts/verify-profile-parity.js
   ```
   If your change also touches `sync-init-fn` or the `devices` CHECK, add:
   ```bash
   node scripts/verify-devices-rebuild-fence.js
   node --test scripts/rehearse-devices-rebuild.test.js
   ```
8. **Both-profile parity.** Confirm `bcm2712` and `bcm2709` payload files
   (flows.json, bundled DB) are still byte-identical —
   `verify-profile-parity.js` in step 7 already covers this; do not hand-wave it.
9. **PR evidence per `docs/engineering-playbook.md` §8** ("Definition of done"):
   re-verify the original issue/claim against current code, keep the written
   plan and its review in the repo, include every gate's real output as re-run
   by a non-author, confirm both profiles/seeds are in parity, and write the PR
   body with root cause, tradeoffs, and evidence — not just a green checkmark.

## Provenance and maintenance

Re-run these to catch drift in the facts above:

```bash
node scripts/verify-migrations.js                      # migration file well-formedness + contiguous versions
node scripts/verify-seed-replay.js                      # migrations replay == seed-blank.sql
node scripts/verify-runtime-schema-parity.js            # boot node devices CHECK + triggers == seed
node scripts/verify-db-schema-consistency.js            # all 7 bundled DBs match hand-maintained contract
node scripts/verify-profile-parity.js                   # bcm2712 == bcm2709 byte-for-byte
node scripts/verify-devices-rebuild-fence.js            # boot-node rebuild is still fail-closed
node --test scripts/rehearse-devices-rebuild.test.js    # boot-node rebuild behaves correctly against 4 seeded cases
node --test lib/osi-migrate/__tests__/*.test.js         # runner unit tests (risk classes, atomicity, drift preflight, partial-batch retry)
find . -name farming.db -not -path '*/node_modules/*'  | sort   # should list exactly 7 paths
ls database/migrations/ordered/                         # current migration set (0001..0007 as of 2026-07-10)
ls .github/workflows/ && cat .github/workflows/migrations.yml .github/workflows/verify-sync-flow.yml   # what CI actually gates (both workflows)
grep -rn "osi-migrate\|applyPending\|bootstrapFresh\|verifyHead" scripts/ lib/ deploy.sh conf/ feeds/chirpstack-openwrt-feed/apps/node-red/files/ --exclude-dir=node_modules   # re-confirm no on-device caller (covers flows.json + init files, not just *.js/*.sh)
```

All commands above were run against this worktree on 2026-07-06 and returned the
outputs quoted in this document, with a clean `git status --short` afterward
(read-only verification, no tracked-file side effects).
