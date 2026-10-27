---
name: osi-schema-change-control
description: Use when changing edge SQLite schema (tables, columns, indexes, triggers, views), seed-blank.sql or bundled farming.db, ordered migrations or lib/osi-migrate, the frozen sync-init-fn boot node, or when a migration/schema verifier fails.
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
| Add ad hoc DDL to `flows.json` or `deploy.sh` without routing through schema change control | `scripts/verify-no-stray-ddl.js` is a git-anchored DDL-marker ratchet over the maintained flow copies and `deploy.sh`. A green migration verifier does not prove this guard will pass. |
| Modify an already-merged `database/migrations/ordered/NNNN__slug.sql` file | `lib/osi-migrate/migrations-loader.js` hashes the raw file bytes (SHA-256) and compares each hash with `CHECKSUMS.json`. A changed file with an unchanged manifest is refused with `ERR_MIGRATION_CORPUS` before the runner opens the database. If the manifest is edited to match, the corpus loads, the hash disagrees with the ledger row of every gateway that already applied the file, and `applyPending` marks that row `repair_required` and stops. |
| Update `seed-blank.sql` or one bundled DB without the others | `verify-seed-replay.js` and `verify-db-schema-consistency.js` both fail if any of the 7 bundled copies drifts from the seed/migration-replay schema. One home for the fact: keep all copies byte/fingerprint-identical in the same commit. |
| Rebuild a parent table (drop/rename swap) without the FK fence | Without `PRAGMA foreign_keys=OFF` held across the swap, `ON DELETE CASCADE` on child tables (`device_data`, `chameleon_readings`) silently wipes their rows when the parent is dropped. This caused a documented field history-loss incident (`docs/operations/edge-history-retention.md`). |
| Run a `destructive`-class migration without writers stopped | `runner.js` enforces this in code — it throws `refuse to run unless writers are stopped (deploy/pre-start)` — because a table rebuild racing a live Node-RED writer can corrupt or lose in-flight rows. |

## Decision table: which mechanism do I use?

| Change | Mechanism | Notes |
|---|---|---|
| New table, column, index, view, or trigger (append-only) | New `additive` ordered migration + `seed-blank.sql` + all 7 bundled DBs | No backup, no writers-stopped gate required by the runner itself, but you still must keep parity surfaces in sync (see Walkthrough). Already-provisioned Pis receive it through `deploy.sh` `run_schema_migration()`. |
| Drop/rename/rebuild a table, or alter a CHECK/constraint that SQLite can't `ALTER` in place | New `destructive` ordered migration | Requires `writersStopped=true`; FK fence in the migration. `deploy.sh` stops Node-RED, checkpoints WAL, and invokes `scripts/migrate-cli.js` with a persistent pre-migration backup under `/data/backups/migrate`; do not invent an ad hoc path. |
| Backfill / data correction against existing rows | New `data` ordered migration | Persistent backup + normal transaction; no FK fence; must be idempotent against the pre-migration row shape. Deploy-time delivery uses the same `run_schema_migration()` path. |
| `devices.type_id` CHECK needs a new device type | New `destructive` ordered migration that rebuilds `devices` (precedents `0027__add_dragino_sdi12_type.sql`, `0060__add_rak10701_field_tester_type.sql`) + the guarded fail-closed rebuild already shipped in `sync-init-fn` (sanctioned exception) | Never add a second rebuild path; extend the existing `REQUIRED_TYPES` set (and `DEVICES_COLUMNS`) and its parity surfaces (`verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js`) — subject to the full boot-node merge gate below (four verifiers + production-copy rehearsal). |
| Idempotent additive repair needed on live Pis at deploy time (e.g. a new column) | New ordered migration delivered by `deploy.sh` `run_schema_migration()` | Do not add `ensure_*` functions. The deploy runner fetches `CHECKSUMS.json`, all ordered migrations, Stage 0 baseline helpers, and `lib/osi-migrate`, then applies pending migrations once writers are stopped. |
| Any other on-device schema mutation | Ordered migration runner path, or no change | If the runner cannot express it safely, stop and design the schema project first; do not add inline DDL to `deploy.sh`, `flows.json`, or init scripts. |

## References

- `references/migration-model.md`: Read before writing or reviewing an ordered migration. Sections: "The model: ownership, migrations, risk classes"; "Ownership (ADR 2026-06-30)"; "Ordered migrations: format and risk-class declaration"; "Risk-class semantics, verified against `lib/osi-migrate/runner.js`"; "Key fact: deploy-time runner, not boot-time runner".
- `references/boot-ddl-freeze.md`: Read before any touch to `sync-init-fn`; holds its merge gate. Sections: "Boot-DDL freeze (the other schema path, and why it's frozen)"; "Incident history (one line each, factual)"; "The sanctioned exception: guarded fail-closed `devices` rebuild"; "Merge gate for any further touch to this block".
- `references/parity-and-deploy-runner.md`: Read when a parity verifier is red. Sections: "Parity surfaces"; "`deploy.sh` migration runner".
- `references/ledger-recovery.md`: Read for fingerprint drift or a `repair_required` or foreign-numbered row. Sections: "Restamp rules"; "Ledger numbering reconciliation".
- `references/walkthrough.md`: Read when adding a column, table, index, or trigger. Sections: "Walkthrough: adding a column end-to-end".
- `references/pitfalls-and-maintenance.md`: Read when a schema change misbehaves or to re-verify this skill. Sections: "Common mistakes"; "Provenance and maintenance".
