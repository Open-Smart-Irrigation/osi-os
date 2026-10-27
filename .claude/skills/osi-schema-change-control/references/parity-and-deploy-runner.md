# Parity surfaces and the deploy-time runner

Part of the osi-schema-change-control skill; read SKILL.md first.

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

Core verifiers each check a different slice. Run them in the current worktree
and report current output; do not reuse old pass strings:

| Verifier | What it checks | Run output |
|---|---|---|
| `scripts/verify-migrations.js` | Every ordered migration file is well-formed; versions contiguous from `0001`; also validates checksum manifest rules when present | exit 0; current script may print a `verify-migrations: OK (...)` summary, but do not require a fixed migration count or exact string |
| `scripts/verify-seed-replay.js` | Replays `bootstrapFresh` over the ordered migrations into a scratch DB and diffs its computed fingerprints (tables/indexes/triggers, excluding the ledger's own bookkeeping tables) against fingerprints from `seed-blank.sql` applied fresh — keeps the migration set and seed honestly equivalent | `verify-seed-replay: OK` |
| `scripts/verify-runtime-schema-parity.js` | Compares `sync-init-fn`'s `devices_new` CHECK type-set and each flow file's whole trigger set (both profiles) against the canonical set derived from `seed-blank.sql` — fails if the boot node ever *downgrades* the seed | `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)` |
| `scripts/verify-db-schema-consistency.js` | Hand-maintained column/index/trigger-fragment contract checked against all 7 bundled DB copies (defaults to the 7-path list above; accepts explicit paths as CLI args), plus an `EXPLAIN QUERY PLAN` check that a history query actually uses `idx_device_data_deveui_recorded_at`. Widest and slowest-changing — must be hand-extended whenever the contract changes (see Walkthrough) | all 7 paths `OK`, then `DB schema consistency verification passed` |

Two related, non-schema-content parity checks this area depends on:
`scripts/verify-devices-rebuild-fence.js` + `node --test
scripts/rehearse-devices-rebuild.test.js` (covered under Boot-DDL freeze above),
and `scripts/verify-profile-parity.js` (byte-for-byte hash comparison of
canonical payload files, including `files/usr/share/db` and
`files/usr/share/flows.json`, between the `bcm2712` source-of-truth profile and
the `bcm2709` mirror). Rerun both in the branch you are changing.

`scripts/verify-no-stray-ddl.js` is the provenance ratchet for DDL-like strings
in `flows.json` and `deploy.sh`. Run it for schema work and for any flow/deploy
edit that introduces, removes, or moves DDL markers. It is separate from
`verify-migrations.js`; passing one does not prove the other.

Do not treat a historical green run as current evidence. Re-run the relevant
commands after changing schema, flow DDL, deploy repair, seed, or bundled DB
surfaces.

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
