# Migration model

Part of the osi-schema-change-control skill; read SKILL.md first.

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

Every runtime corpus requires a strict CHECKSUMS.json, including selected references and synthetic fixtures. Preserve the accepted parent checksums when constructing a prefix. Operator authority and corruption recovery are defined in [migration manifest authority](../../../../docs/operations/migration-manifest-trust.md); never regenerate expected hashes from suspect files.

Files live at `database/migrations/ordered/NNNN__slug.sql`. Check the current
inventory before choosing a version:

```bash
ls database/migrations/ordered/
```

Use the next contiguous four-digit version after the highest `NNNN` present; do
not copy an example version from this skill. `CHECKSUMS.json` is mandatory for runtime loading. Keep it consistent when authoring a new migration; never edit already-recorded migration bytes or regenerate expected hashes from suspect files.

The filename format is enforced by a regex in
`lib/osi-migrate/migration-manifest.js`, which checks every `CHECKSUMS.json` key:
`^([0-9]{4})__([a-z0-9_]+)\.sql$` (four-digit version, double underscore,
lowercase slug). The loader then requires the `.sql` files on disk to equal the
manifest keys exactly. Versions must be unique and are sorted numerically, not
lexically.

**The risk class is declared in a mandatory file header, not inferred from
content or filename.** `migrations-loader.js` requires the first non-blank line
(a UTF-8 BOM and leading blank lines are tolerated) to match
`-- risk: additive|destructive|data`. A migration missing this header throws
`ERR_MIGRATION_CORPUS` (`migration corpus: migration <file> missing '-- risk:
additive|destructive|data' header`), and the whole corpus is rejected before any
migration runs. Example, verbatim from `0002__gateway_health.sql`:

```sql
-- risk: additive
-- 0002: Persist aggregated gateway CPU health reporting (osi-os issue #68).
```

Each migration file is also SHA-256 checksummed over its **raw bytes**
(`crypto.createHash('sha256').update(raw)` in `migrations-loader.js`). The
checksum is enforced at two points:

1. At corpus load, before any database access, the hash must equal the file's
   `CHECKSUMS.json` entry. A mismatch throws `ERR_MIGRATION_CORPUS`
   (`checksum mismatch for <file>`); `applyPending`, `bootstrapFresh` and
   `verifyHead` refuse before they touch the ledger. Editing a merged file
   without its manifest entry stops here.
2. On success the runner stores the checksum in the
   `schema_migrations` row. If the file and its manifest entry were both
   changed, the corpus loads, but the checksum no longer matches the stored
   row on a gateway that already applied it: `applyPending` marks that row
   `repair_required` and throws.

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
