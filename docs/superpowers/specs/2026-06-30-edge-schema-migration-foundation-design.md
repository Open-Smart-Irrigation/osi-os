# Edge Schema Migration Foundation

**Status:** Draft — spec (revised per round-2 spec review 2026-06-30; ready for implementation plan)
**Created:** 2026-06-30
**Scope:** osi-os edge only (SQLite). No osi-server changes except CI.
**Decision record:** [ADR — Schema and cross-repo contract ownership](../../adr/2026-06-30-schema-and-contract-ownership.md)
**Runs in parallel with:** [Sync-Contract Package](./2026-06-30-sync-contract-package-design.md) Tranche A (Spec 2); they share the CI workflow this spec introduces

---

## 1. Problem

The edge encodes its SQLite schema in three drifted places with no ledger of what has actually been applied to any device:

1. `database/seed-blank.sql` — full `CREATE` script for a fresh device (35 tables, 19 triggers).
2. The Node-RED node `Sync Init Schema + Triggers` (`sync-init-fn`) — runs on **every boot**: ~92 idempotent `ALTER TABLE ADD COLUMN`, a `devices` CHECK table-rebuild, trigger creation, and ~24 data `UPDATE`s, all inside `for (const sql of stmts) { try { await exec(sql); } catch (_) {} }` (errors swallowed). A second node (`dendro-compute-fn`) independently ensures 6 analytics tables and ~79 more `ADD COLUMN`s; ~12 nodes contain DDL in total.
3. `scripts/repair-pi-schema.js` — an out-of-band idempotent repair script with the safe primitives (`PRAGMA table_info` introspection, `addColumnIfMissing`, `ensureDeviceTypeCheckIncludesLorain`, `CREATE … IF NOT EXISTS`).

The dated files in `database/migrations/` are **orphaned** — no general runner applies them in order; there is no `schema_migrations` table anywhere.

**Verified harms of this architecture:**

- The boot rebuild recreated `devices` with a CHECK missing `AQUASCOPE_LORAIN`, silently downgrading the constraint after every restart until `repair-pi-schema.js` re-fixed it; with errors swallowed, a `AQUASCOPE_LORAIN` row present at restart could empty `devices` (hotfixed in `a646efe3`).
- Trigger drift: `trg_dp_chameleon_readings_outbox_ai` in runtime but not seed; `sync_dendro_to_readings` in seed but not recreated by runtime. `verify-db-schema-consistency.js` checks columns/indexes but **not trigger bodies**, so a device can be "consistent" yet run drifted trigger logic.
- A documented field **history-loss incident** from an unfenced boot-time `devices` rebuild cascading deletes into `device_data`, `chameleon_readings`, `dendrometer_readings` (`docs/operations/edge-history-retention.md`).
- A reported `verify-sync-flow.js` migration test failure (`duplicate column name: data_invalid`) — a non-idempotent-migration symptom — to be confirmed and folded in.

There is one **live production device** (Uganda) whose canonical history must not be lost. Demo/test devices are freely rebuildable. The first production deployments are expected within weeks of this writing.

## 2. Decision

Make **ordered, versioned, idempotent SQL migrations + a runner + a `schema_migrations` ledger** the single executable authority for the edge SQLite schema. Migrations apply exactly once per device, in order, transactionally where possible, with backups and pre/postflight checks around risky operations, and never swallow errors. `seed-blank.sql` becomes a canonical artifact verified to equal "empty DB + replay all migrations." The inline DDL across ~12 nodes and the repair script collapse into the runner. Risky migration runs at **deploy time**; boot is reduced to ledger-verification and fresh-device bootstrap.

This is the executable core of Option C in the ADR. The cross-repo contract layer is Spec 2.

## 3. Architecture

```
database/
  migrations/
    NNNN__<slug>.sql          ← ordered, versioned, idempotent (additive or destructive)
    ...
  seed-blank.sql              ← canonical; CI-verified == empty DB + replay(migrations)

lib/osi-migrate/              ← shared, repo-root, copied into each profile's node-red/
  runner.js                   ← apply pending migrations, ledger, tx, pre/postflight, backup
  ledger.js                   ← schema_migrations read/write + per-object fingerprints
  backup.js                   ← online-backup via node-sqlite3 `.backup()` (CLI: `sqlite3 .backup`); verified-open + integrity_check
  sql-runner-iface.js         ← thin { run, all, exec } interface (async)
  index.js                    ← exports: applyPending(runner, opts), bootstrapFresh(runner), verifyHead(runner)
  __tests__/

conf/<profile>/files/usr/share/node-red/osi-migrate/   ← build-copied; parity-guarded
scripts/
  repair-pi-schema.js         ← becomes a thin CLI over lib/osi-migrate (ops + deploy path)
  verify-seed-replay.js       ← NEW: assert seed-blank.sql == empty DB + replay
  verify-migrations.js        ← NEW: ledger/checksum/ordering invariants, idempotency
  (existing verify-* unchanged)
```

### Invariants

1. **Migrations apply exactly once**, recorded in `schema_migrations`. The runner never re-runs an applied migration.
2. **No boot-time mutation of a populated DB beyond what is explicitly safe.** Deploy is the primary migration trigger; boot verifies the ledger head and bootstraps fresh DBs only (see §6).
3. **Destructive migrations run with writers quiesced and FK enforcement toggled *outside* any transaction.** `PRAGMA foreign_keys=OFF` is a silent no-op inside an open transaction (verified on SQLite 3.53), so a table rebuild sets it before `BEGIN`, with Node-RED stopped (no concurrent writers). Backups use the SQLite **online-backup API** (or stop-writers + `PRAGMA wal_checkpoint(TRUNCATE)`) — never a naive copy of a live WAL DB — and are opened and `integrity_check`-verified before the migration proceeds; postflight runs `PRAGMA integrity_check` + `PRAGMA foreign_key_check`.
4. **No swallowed errors.** A failed migration aborts cleanly (`ROLLBACK`), leaves the DB in its last-good state, and records `status=failed` + `error` in the ledger **on a clean connection after the rollback** (a ledger write inside the failed transaction would be rolled back with it).
5. **`seed-blank.sql` is canonical and CI-verified** to equal empty-DB + replay(all migrations). The bundled image `farming.db` seeds are verified against it (existing `verify-db-schema-consistency.js`).
6. **The runner is dialect-pure SQLite** and owns no cross-repo concerns (those are Spec 2).
7. **Additive and destructive migrations use different execution paths** (§5): additive run inside `BEGIN IMMEDIATE`; destructive run only with Node-RED stopped and FK enforcement toggled outside any transaction.

## 4. Migration files

- Naming: `NNNN__<slug>.sql`, zero-padded monotonic version (`0001__baseline.sql`, `0002__add_lorain_devices_check.sql`). Ordering is by version number.
- Each file is **idempotent** at the statement level where cheap (`CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`, guarded `ADD COLUMN`) and **declares its risk class** via a header comment: `-- risk: additive` | `-- risk: destructive` (rebuild/backfill/trigger-replace). The runner reads the class to decide backup/fence/deploy-only handling.
- A **baseline migration** (`0001`) reproduces the current canonical schema (tables, indexes, triggers) so a fresh empty DB + replay equals `seed-blank.sql`. **Replay==seed proves only the seed path, not that a drifted field DB matches.** Existing field devices are stamped "baseline applied" during cutover (§7) *only after* a per-device match gate passes: semantic schema fingerprints, trigger bodies, `devices` CHECK coverage, data/history-row invariants, and a production-copy dry run. A device that fails the gate is marked `repair_required`, never stamped.
- Destructive primitives provided as documented patterns (not magic): the `devices` CHECK rebuild uses the fenced create/copy/verify-count/swap from the hotfix (FK off before `BEGIN`, writers stopped); trigger replacement compares **semantic fingerprints** (normalized body + normalizer version; SQLite engine version is diagnostics only) and does an intentional `DROP`/`CREATE`.

## 5. The runner

`lib/osi-migrate` exposes three entry points over a thin `{ run, all, exec }` async interface so the same logic runs under Node-RED's `sqlite3` (async) and is testable with `better-sqlite3` (sync, wrapped). No heavier abstraction than this interface.

- `applyPending(runner, opts)` — read `schema_migrations`; compute pending (version > last applied; a recorded-checksum mismatch ⇒ alert + `repair_required`, never silently skip). For each pending in order, branch on declared risk class:
  - **Additive:** `BEGIN IMMEDIATE` (busy_timeout set) → apply → postflight → record → commit.
  - **Destructive:** require writers stopped (deploy/pre-start context; refuse otherwise) → online-backup (node-sqlite3 `.backup()`; CLI `sqlite3 .backup`) + verify-open + `integrity_check` → `PRAGMA foreign_keys=OFF` (**outside any transaction**) → `BEGIN IMMEDIATE` → create/copy/verify-count/swap → `COMMIT` → `PRAGMA foreign_keys=ON` → postflight (`integrity_check`, `foreign_key_check`) → record. **On failure:** `ROLLBACK`, restore `PRAGMA foreign_keys=ON`, then write the `status=failed` ledger row **on a clean connection after the rollback** — a ledger write inside the failed transaction would roll back with it.
  Record `version, name, checksum, applied_at, finished_at, status, error, app_version, backup_path`. Abort the whole run on first failure; do not advance the head.
- `bootstrapFresh(runner)` — for a brand-new empty DB: replay all migrations, stamp the ledger.
- `verifyHead(runner)` — cheap boot check: is the ledger at the expected head and do per-object fingerprints match? If not, log and set a `repair_required` signal; do **not** mutate.

**Ledger schema** (`schema_migrations`): `version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT, finished_at TEXT, status TEXT, error TEXT, app_version TEXT, backup_path TEXT`. Plus **semantic** `schema_object_fingerprints` derived from `PRAGMA table_xinfo` / `foreign_key_list` / `index_list` / `index_xinfo` **plus the normalized CREATE SQL for the parts PRAGMA omits — CHECK constraints and partial-index predicates** (whitespace-collapsed, case-preserved so string literals stay significant), tagged with the normalizer version only — not a brittle hash of each object's entire raw SQL or the SQLite engine version. Record `sqlite_version()` separately as diagnostics when needed so harmless engine upgrades do not look like schema drift. (PRAGMA alone cannot see a CHECK change, e.g. the LORAIN drift.) Recomputed and compared on `verifyHead`; **unexpected drift sets `repair_required`, it never triggers an automatic rewrite.** A single head version is a summary, not proof.

**SQLite safety rules** baked into the runner: `PRAGMA busy_timeout` set; additive migrations take the write lock with `BEGIN IMMEDIATE`; preflight checks free disk (for copy-table rebuilds) and dirty data before `CREATE UNIQUE INDEX`. For a rebuild, **FK enforcement is toggled outside any transaction with Node-RED stopped** — an open transaction makes `PRAGMA foreign_keys=OFF` a silent no-op (verified on SQLite 3.53) — `ON` restored immediately after the final drop. Backups use the **online-backup API** (or stop-writers + `wal_checkpoint(TRUNCATE)`), are opened and `integrity_check`-verified, and include the DB plus any `-wal`/`-shm`; postflight `integrity_check` + `foreign_key_check`.

## 6. Boot vs deploy execution model

- **Deploy (`deploy.sh`) is a state machine, not a script:** `stage package → backup (online API, verified) → migrate (runner, Node-RED stopped) → verify (integrity/FK/fingerprints) → promote code + restart Node-RED`. **Migration failure halts promotion** — the new flows/code are not installed and Node-RED is not restarted on the new package; the device stays on last-good code with its backup intact.
- **Pre-start gate (outside Node-RED):** an init step that runs *before* Node-RED launches covers update paths that bypass `deploy.sh` (e.g. image reflash). It `bootstrapFresh`es a brand-new DB and applies *additive* pending migrations with backup; for a pending *destructive* migration it either applies it (writers are not yet up) or refuses to start the schema-dependent flows and flags `repair_required`. Node-RED never starts against a DB whose ledger head it cannot trust.
- **Boot (Node-RED)** is reduced to `verifyHead` only; it does **not** mutate a populated DB. The historical FK fence remains as defense-in-depth.
- **Ops (`repair-pi-schema.js`)** becomes a thin CLI over the same runner for manual field repair, preserving its non-schema diagnostics (duplicate-history-row reporting, index verification).

This honors the incident lesson: destructive mutation never runs with writers live; it runs once, backed-up, with FK toggling outside any transaction, in the deploy or pre-start context.

## 7. Consumer rewiring & drift reconciliation

- `sync-init-fn` → `bootstrapFresh`/`verifyHead` only; its ~92 inline `ADD COLUMN`s, the rebuild, and the 24 data `UPDATE`s become ordered migrations.
- `dendro-compute-fn` and the other DDL-bearing nodes → drop inline ensures; tables/columns guaranteed by migrations.
- `repair-pi-schema.js` → thin CLI over the runner.
- `seed-blank.sql` (+ bundled `farming.db`) → verified against replay (`verify-seed-replay.js`).
- Profiles → `lib/osi-migrate` copied into each profile's `node-red/`; `verify-profile-parity.js` extended to guard the copies.
- Drift items become explicit migrations: `0002` add `AQUASCOPE_LORAIN` to `devices` CHECK (destructive, fenced — subsumes hotfix `a646efe3`); add `trg_dp_chameleon_readings_outbox_ai`; reconcile `sync_dendro_to_readings`; the 92+79 `ADD COLUMN`s (additive); the 24 data `UPDATE`s (data migrations); triggers reconciled by **semantic fingerprints** (§5), not raw SQL hashes. Confirm and fix the reported `data_invalid` duplicate-column migration.

## 8. CI

- **osi-os:** new workflow runs `verify-migrations.js`, `verify-seed-replay.js`, the migration test suite (§9), and wires the currently-unwired verifiers (`verify-db-schema-consistency`, `verify-channel-manifest-parity`, `verify-sync-flow`, `verify-command-safety`, `verify-profile-parity`, `verify-sync-contract`). `verify-sync-contract` is extended now to cover **events** (not just commands) and registry↔schema parity in both directions — a cheap CI gate for the command/event drift class (the `REMOVE_DEVICE_FROM_ZONE`/`UNCLAIM_DEVICE` class), independent of Spec 2's codegen.
- **osi-server:** stand up CI from zero — `gradlew build` + `flyway validate` against a throwaway Postgres service container + backend tests. (Edge migrations are not osi-server's concern; this is the enforcement floor the cross-repo work in Spec 2 will build on.)

## 9. Testing

Beyond happy-path (replay == seed, idempotency, run-once, convergence from historical DB snapshots):

1. **Concurrent writes during migration** — a second connection inserting into `device_data` while a migration runs; assert no loss and no `SQLITE_BUSY` deadlock.
2. **Interrupted rebuild recovery** — kill mid-rebuild (between drop and rename); on restart the runner either completes or cleanly detects the intermediate state; no empty `devices`.
3. **WAL pending-transaction isolation** — uncommitted writer on one connection while migrating on another; no dirty reads, no indefinite block.
4. **Large-table timing** — run against a production-sized `device_data` clone; measure wall-clock; confirm boot/deploy latency budget.
5. **Trigger equivalence under whitespace** — two triggers identical except whitespace must hash-compare equal (normalize), or they DROP/CREATE every run.
6. **Backup/restore of WAL+SHM** — restore from a destructive-migration backup and verify integrity.
7. **Dirty-data preflight** for `CREATE UNIQUE INDEX`.
8. **FK fence actually disables enforcement** — assert that during a rebuild `PRAGMA foreign_keys` reads `0` (the toggle happened outside a transaction); regression-guard that the rebuild path is *not* wrapped in an outer transaction.
9. **Backup is restorable** — the online-API backup opens, passes `integrity_check`, and round-trips data; restoring after a deliberately-failed destructive migration leaves the original intact.

## 10. Phasing

- **P1 — Runner + ledger + baseline.** Build `lib/osi-migrate`, the `0001` baseline, `verify-seed-replay.js`; prove replay == seed and idempotency. No flow change.
- **P2 — Drift migrations + consumer rewiring.** Author `0002…` migrations for the verified drift; rewire `sync-init-fn`/`dendro-compute-fn`/other nodes/`repair-pi-schema.js`; profile parity.
- **P3 — Execution model + CI.** Wire `deploy.sh` to run the runner; reduce boot to verify/bootstrap; stand up CI in both repos.
- **P4 — Validate on hardware.** Reseed a rebuildable demo Pi (fresh path) and run a convergence dry-run against a copy of the production schema before any production rollout.

## 11. Risks

| Risk | Mitigation |
|------|------------|
| A destructive migration loses data on the live DB | Writers stopped; FK off *outside* any transaction; online-API backup verified before proceeding; postflight `integrity_check`/`foreign_key_check`; deploy/pre-start only; validated on a production-schema copy first. |
| Baseline stamping marks a drifted device as clean | Per-device match gate (semantic fingerprints, trigger bodies, CHECK coverage, data/history invariants, production-copy dry run, proof old boot-time DDL removed) *before* stamping; failure ⇒ `repair_required`. |
| Update path bypasses `deploy.sh` (image reflash) | Pre-start gate outside Node-RED applies additive pending with backup or refuses to start schema-dependent flows; not merely a boot-time flag. |
| A migration fails in the field on an unattended device | Deploy state machine does not promote/restart on failure; device stays last-good with backup; recovery = forward repair migration (logic error) or restore pre-migration backup + redeploy last-good app (corruption). |
| Can't observe fleet schema state | Telemetry beyond ledger head: expected/applied head, runner/app version, pending count, last failed migration + checksum, backup id, repair reason, last verify result + duration, free disk, DB fingerprint, integrity/FK results. |
| Runner async/sync impedance | Single thin `{run,all,exec}` interface; async runner, `better-sqlite3` wrapped for tests. |

## 12. Out of scope

The sync-contract package and any generated cross-repo types (Spec 2); a Postgres adapter or shared DDL generator (rejected, see ADR); column renames; edge↔cloud `contract_version` negotiation.
