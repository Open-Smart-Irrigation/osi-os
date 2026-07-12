# 04 — Edge database

[← Edge backend](03-edge-backend-flows.md) · [Index](README.md) · [→ Edge GUI](05-dashboard-gui.md)

Canonical state is one SQLite file per gateway, `/data/db/farming.db`, WAL
mode, written through `osi-db-helper`'s serialized queue. The file lives for
the device's operational life; farm history in it is not reproducible.
Consequences: no reseeding, no ad-hoc DDL, schema changes only through the
ordered migration ledger.

Schema source of truth for a fresh database:
[database/seed-blank.sql](../../../database/seed-blank.sql). Seven bundled
`farming.db` copies (five profile payloads plus `database/farming.db` and
`web/react-gui/farming.db`) must stay schema-identical to it;
`scripts/verify-db-schema-consistency.js` checks all seven.

## Tables by domain

Roughly 44 tables at the snapshot. Column detail lives in the seed file.

| Domain | Tables | Notes |
|---|---|---|
| Accounts/structure | `users`, `farms`, `irrigation_zones`, `zone_seasons` | bcrypt password hashes; per-row UUIDs stamped by triggers; zones soft-delete via `deleted_at`. |
| Telemetry | `device_data` | One row per uplink; one column per channel (`swt_1..3` kPa canonical, `swt_wm1/2` read-only legacy aliases, temperatures, humidity, wind, `rain_gauge_cumulative_mm`/`rain_mm_delta`, `bat_v`/`bat_pct`, valve states, `pipe_pressure_kpa`). Hot index: `idx_device_data_deveui_recorded_at`. |
| Devices | `devices` | Registry keyed by `deveui`; `type_id` constrained by a CHECK list (rebuild governance below); per-device config columns (Chameleon depths, dendro calibration); `current_state` for valves. |
| Chameleon | `chameleon_readings`, `chameleon_calibrations`, `chameleon_calibration_misses` | Raw resistances + status flags; global calibration curves keyed by 16-hex `array_id`; 24 h negative cache. `device_data.swt_*` stays the application-facing copy. |
| Dendrometry | `dendrometer_readings`, `dendrometer_daily`, `dendro_baselines` | µm-resolution history with validity/outlier flags; daily v5 indicators (`mds_um`, `twd_um`, stress); reference baselines. |
| Irrigation | `irrigation_schedules`, `irrigation_events`, `actuator_log`, `valve_actuation_expectations`, `zone_valve_assignments`, `zone_irrigation_calibration`, `zone_irrigation_state` | Schedules carry `trigger_metric` + `threshold_kpa` (stress level 1–4 when metric is DENDRO). Expectations: `commanded_at`, `expected_close_at`, observed timestamps, `reconciliation_state`, `estimated_gross_liters` with `volume_source`. Estimated liters never mix with measured `flow_liters`. |
| Zone environment | `zone_daily_environment`, `zone_daily_recommendations`, `zone_shared_environment`, `weather_station_zones`, `zone_weather_cache`, `gateway_locations` | Daily per-zone aggregates with `rain_source` provenance; station→zones many-to-many. |
| History/analysis UI | `history_channel_rollups`, `history_workspaces`, `history_card_preferences`, `analysis_views` | Pre-aggregation for chart latency on Pi hardware; saved layouts and views. |
| Sync | `sync_outbox`, `sync_inbox`, `sync_cursor`, `sync_link_state`, `command_ack_outbox`, `applied_commands`, `sync_history_cursors`, `sync_history_dirty_keys`, `sync_history_segments`, `sync_history_quarantine`, `ingest_quarantine` | Delivery state, inbound dedupe, cursors, effect-key ledger, history shadow bookkeeping, malformed-payload quarantine. Chapter [06](06-edge-cloud-sync.md). |
| Ops/support | `gateway_health_samples` (14 d), `gateway_health_hourly` (365 d), `improvement_requests`, `field_tester_uplinks`, `field_tester_rxinfo`, `lsn50_shadow_diff` | Health persistence from osi-os #68; work-request intake; RAK10701 coverage data; writer-cutover shadow diffs. |
| Runner-owned | `schema_migrations`, `schema_object_fingerprints` | Ledger and fingerprint baseline. Created by `lib/osi-migrate/ledger.js`, absent from the seed, never hand-edited. |

## Trigger architecture

The seed defines ~30 triggers in three groups:

- Outbox enqueue (`trg_dp_*_outbox_ai/au`, `trg_sync_*_outbox_au`): synced
  tables emit `sync_outbox` events on insert/update. The `device_data`
  trigger fires on INSERT only; historical UPDATE repairs must enqueue
  `DEVICE_DATA_APPENDED` events explicitly or the mirror stays stale.
- Dirty-key marking (`trg_sync_*_dirty_ai/au`): feeds history shadow sync.
- Defaults (`trg_sync_*_defaults_ai`, `*_uuid_ai`): stamps UUIDs and sync
  defaults on insert; `sync_dendro_to_readings` bridges live and history
  dendro tables.

## Migration system

Governed by the ADR
[docs/adr/2026-06-30-schema-and-contract-ownership.md](../../adr/2026-06-30-schema-and-contract-ownership.md):
edge DDL belongs to ordered migrations; cloud DDL belongs to Flyway; cross-repo
compatibility belongs to versioned sync contracts, not shared DDL.

Files: [database/migrations/ordered/](../../../database/migrations/ordered),
`NNNN__slug.sql` with a mandatory first-line header
`-- risk: additive|destructive|data`, checksummed (SHA-256 over raw bytes)
into `CHECKSUMS.json` and the ledger. `0001__baseline.sql` through
`0014__improvement_request_status_secret.sql` at the snapshot. Merged files
are immutable; a checksum mismatch marks the ledger row `repair_required` and
blocks the runner.

Runner: [lib/osi-migrate/](../../../lib/osi-migrate) (`runner.js`,
`migrations-loader.js`, `ledger.js`, `fingerprints.js`, `backup.js`,
`sql-normalize.js`, tests in `__tests__/`). Risk-class mechanics:

| Class | Fence | Backup | Gate |
|---|---|---|---|
| `additive` | `BEGIN IMMEDIATE … COMMIT` | none | none |
| `destructive` | `PRAGMA foreign_keys=OFF` outside the transaction, DDL inside `BEGIN IMMEDIATE … COMMIT`, `foreign_keys=ON` restored after | online backup, keep 5 | refuses without `writersStopped: true` |
| `data` | normal transaction | online backup | idempotency against pre-migration rows is the author's contract |

All classes run a postflight (`PRAGMA integrity_check` = `ok`,
`PRAGMA foreign_key_check` empty). Fingerprints re-stamp per migration, so a
failed batch leaves migrations 1..k-1 consistently stamped and retryable. A
preflight compares live fingerprints against the stored baseline and refuses
on drift, pointing at `scripts/restamp-fingerprints.js` as the sanctioned
recovery for a verified-good schema.

Execution happens at deploy time, not boot. `deploy.sh run_schema_migration()`
fetches the migration corpus, `scripts/migrate-cli.js`, and the runner onto
the Pi; stops Node-RED (30 s wait), checkpoints WAL, runs the Stage 0
first-baseline path on ledger-less databases
(`scripts/repair-sync-outbox-v2.js`, then `scripts/baseline-existing-db.js`
gated by `scripts/semantic-schema-compare.js`), and applies pending
migrations with backups under `/data/backups/migrate`.

The boot node `sync-init-fn` ("Sync Init Schema + Triggers") still executes
legacy inline DDL each boot (~93 `ADD COLUMN`s) and is frozen for new schema
behavior. Its sanctioned exception is the fail-closed `devices` CHECK
rebuild: set-equality guard on the required type list, plain `INSERT` copy
inside `_db.transaction()` so a CHECK violation rolls back, FK toggle
restored in `finally`. Any touch to that block re-runs four gates
(`verify-runtime-schema-parity.js`, `verify-profile-parity.js`,
`verify-devices-rebuild-fence.js`, `node --test
scripts/rehearse-devices-rebuild.test.js`).

## Verifier matrix

| Script (`scripts/`) | Invariant |
|---|---|
| `verify-migrations.js` | Migration files well-formed, versions contiguous, checksums consistent. |
| `verify-seed-replay.js` | Fingerprints of replayed migrations equal fingerprints of the seed. |
| `verify-db-schema-consistency.js` | All 7 bundled DBs match the hand-maintained contract; history query uses `idx_device_data_deveui_recorded_at` (EXPLAIN QUERY PLAN). |
| `verify-runtime-schema-parity.js` | Boot node cannot downgrade the seed (devices CHECK set, trigger set, both profiles). |
| `verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild.test.js` | Rebuild stays fail-closed; rehearsal executes the shipped function text against `node:sqlite` across four seeded cases. |
| `verify-no-stray-ddl.js` | Git-anchored ratchet against DDL markers in flows.json and deploy.sh. |
| `verify-profile-parity.js` | bcm2712 and bcm2709 payloads byte-identical. |
