# 04 — Edge Database

[← Edge backend](03-edge-backend-flows.md) · [Index](README.md) · [→ Dashboard](05-dashboard-gui.md)

Each gateway keeps its whole world in **one SQLite file**: `/data/db/farming.db`.
It lives for the operational life of the device and holds irreplaceable farm
history, which is why it is under strict change control and why the deploy
tooling refuses to ever overwrite it.

The schema's readable source of truth is
[database/seed-blank.sql](../../../database/seed-blank.sql) (what a brand-new
database looks like). Seven pre-built copies of that blank database are bundled
in the repo (one per firmware profile plus two developer conveniences); a
verifier keeps all seven identical.

## The tables, grouped by purpose

Around 44 tables. Plain-language description per group; exact columns are in
`database/seed-blank.sql`.

### People and farm structure

| Table | What it holds |
|---|---|
| `users` | The farmer accounts on this gateway (name, bcrypt-hashed password, per-user UUID for sync). |
| `farms` | Farm records grouping devices. |
| `irrigation_zones` | The plots/fields ("Zone North", "Greenhouse 2"): name, crop, owner, soft-delete tombstone. |
| `zone_seasons` | Growing-season date ranges per zone. |

### Devices and their readings

| Table | What it holds |
|---|---|
| `devices` | Every registered field device: radio ID (`deveui`), type (guarded by an allowed-type list), zone assignment, per-device settings (probe depths, dendro calibration), current valve state. |
| `device_data` | **The main telemetry ledger**: one row per received sensor reading, with one column per possible measurement (soil tension `swt_1..3`, temperatures, humidity, wind, rain, battery, valve states, pipe pressure …). Most dashboards and the scheduler read from here. |
| `chameleon_readings` | Raw/diagnostic mirror for Chameleon soil probes (electrical resistances, status flags, calibration status): the "lab notebook" behind the polished `device_data` values. |
| `chameleon_calibrations` | Global calibration curves per probe array (fetched from the manufacturer via the cloud). |
| `chameleon_calibration_misses` | A 24-hour "we already asked, they don't have it" note so the gateway doesn't pester the cloud about unknown arrays. |
| `dendrometer_readings` | High-resolution tree-girth history (micrometers), with validity/outlier flags. |
| `dendrometer_daily` | One row per tree per day: max/min size, growth, shrinkage (MDS), water deficit (TWD), stress level. |
| `dendro_baselines` | Per-tree reference values the analytics compare against. |
| `lsn50_shadow_diff` | Temporary safety net from the writer refactor: records any difference between the old and the new LSN50 write path while both run side by side. |

### Irrigation control

| Table | What it holds |
|---|---|
| `irrigation_schedules` | The watering rules per zone: trigger metric (soil tension channels or dendro stress), threshold, duration, enabled flag. |
| `irrigation_events` | The narrative log of irrigation decisions ("zone X irrigated for 20 min because mean 41 kPa ≥ 35"). |
| `actuator_log` | Low-level record of every command sent to a valve. |
| `valve_actuation_expectations` | The "we expect valve Y open until 07:10" contract rows the reconciliation monitor checks; states include pending, observed-running, cancelled. |
| `zone_valve_assignments` | Which valves water which zone. |
| `zone_irrigation_calibration` | Measured flow rate per zone (liters/minute) used to *estimate* delivered liters. Estimates are kept strictly separate from measured flow-meter data. |
| `zone_irrigation_state` | Rolling per-zone irrigation state used by analytics. |

### Zone environment and recommendations

| Table | What it holds |
|---|---|
| `zone_daily_environment` | One row per zone per day: rainfall (with its source gauge), temperatures, measured flow liters. |
| `zone_daily_recommendations` | Daily irrigation recommendations per zone (from the dendro analytics). |
| `zone_shared_environment` | Environment values shared into a zone from devices in other zones (e.g. one weather station serving several zones). |
| `weather_station_zones` | The many-to-many map "this weather station serves these zones". |
| `zone_weather_cache` | Cached external weather data per zone. |
| `gateway_locations` | The gateway's GPS position history. |

### History & analysis UI support

| Table | What it holds |
|---|---|
| `history_channel_rollups` | Pre-computed hourly/daily summaries per measurement channel so history charts load fast on a Pi. |
| `history_workspaces` | Saved history-dashboard layouts per user. |
| `history_card_preferences` | Per-card display preferences (ranges, visibility). |
| `analysis_views` | Saved cross-zone analysis chart configurations. |

### Sync plumbing (details in chapter [06](06-edge-cloud-sync.md))

| Table | What it holds |
|---|---|
| `sync_outbox` | The outgoing mail tray: every local change waiting to be delivered to the cloud. |
| `sync_inbox` | The stamp collection of already-processed incoming commands; it guarantees a re-delivered command is applied only once. |
| `sync_cursor` | Bookmarks: how far each sync stream has progressed. |
| `sync_link_state` | Whether/atop which cloud account this gateway is linked, plus tokens state. |
| `command_ack_outbox` | Outgoing receipts ("command 123: applied") awaiting delivery. |
| `applied_commands` | Ledger of physical effects already performed, keyed by `effect_key`, so a replayed valve command can never water twice. |
| `sync_history_cursors` / `sync_history_dirty_keys` / `sync_history_segments` / `sync_history_quarantine` | The history shadow-sync bookkeeping: what changed, which hashed segment batches were shipped, and any rows the cloud rejected. |
| `ingest_quarantine` | Malformed inbound payloads parked for inspection instead of being silently dropped. |

### Gateway health & support

| Table | What it holds |
|---|---|
| `gateway_health_samples` | Raw 60-second CPU/memory/load/fan/temperature samples (kept ~14 days). |
| `gateway_health_hourly` | Hourly min/mean/max rollups (kept ~365 days). |
| `improvement_requests` | Farmer feedback/problem reports filed from the dashboard, with delivery status to the cloud. |
| `field_tester_uplinks` / `field_tester_rxinfo` | Radio-coverage measurements from the RAK10701 field tester. |

### Bookkeeping owned by the migration runner (not in the seed)

| Table | What it holds |
|---|---|
| `schema_migrations` | The ledger: which numbered migration ran when, with a checksum of the exact file that ran. |
| `schema_object_fingerprints` | A tamper-evident fingerprint of the live schema; recomputed after each migration. Never hand-edited. |

## Triggers: the database's reflexes

The seed defines ~30 triggers, small automatic reactions inside SQLite:

- **Outbox triggers** (`trg_dp_*_outbox_ai/au`, `trg_sync_*_outbox_au`): whenever
  a synced table gains or changes a row, a matching event is dropped into
  `sync_outbox` automatically. The flows never have to remember to do it.
  (Caveat that has bitten before: the `device_data` trigger fires on *insert*,
  not on historical *updates*; repairs of old rows must enqueue events
  explicitly.)
- **Dirty-key triggers** (`trg_sync_*_dirty_*`): they mark which history rows changed
  so the shadow sync knows what to re-ship.
- **Defaults/UUID triggers** (`trg_sync_*_defaults_ai`, `trg_sync_users_uuid_ai`,
  …): stamp fresh rows with UUIDs and sync defaults.
- `sync_dendro_to_readings` keeps the dendro live table and history table in step.

## How the schema changes: the migration system

Since the 2026 refactor, edge schema changes are **ordered migrations**: numbered,
checksummed renovation orders, governed by the ADR
[docs/adr/2026-06-30-schema-and-contract-ownership.md](../../adr/2026-06-30-schema-and-contract-ownership.md).

- **The files:** [database/migrations/ordered/](../../../database/migrations/ordered):
  `0001__baseline.sql` … `0014__improvement_request_status_secret.sql` at the
  snapshot date, plus `CHECKSUMS.json`. Each file's first line declares its risk
  class: `additive` (only adds things), `destructive` (rebuilds/drops; requires
  all writers stopped and takes a backup first), or `data` (fixes rows; takes a
  backup). A merged migration file is never edited again; its checksum is stored
  in the ledger and any later mismatch blocks the runner.
- **The runner:** [lib/osi-migrate/](../../../lib/osi-migrate):
  `runner.js` (applies pending migrations with per-class safety rules and a
  schema-drift preflight), `migrations-loader.js` (filename/header/checksum
  rules), `ledger.js` (the two bookkeeping tables), `fingerprints.js`
  (schema fingerprint math), `backup.js` (online backups, keep newest 5),
  `sql-normalize.js`, and unit tests under `__tests__/`.
- **When it runs:** at **deploy time**, not at boot. `deploy.sh`'s
  `run_schema_migration()` (line ~252) downloads the migration corpus and the
  runner onto the Pi, stops Node-RED, checkpoints the database, baselines
  first-time devices, and applies whatever is pending via
  `scripts/migrate-cli.js` with backups under `/data/backups/migrate`.
- **The frozen legacy path:** the boot node "Sync Init Schema + Triggers" in the
  flow file still executes old inline schema statements every boot, but is
  frozen: no new schema behavior may be added there. Its one sanctioned
  exception is a fail-closed rebuild of the `devices` type list.
- **Recovery tools:** `scripts/restamp-fingerprints.js` (re-baseline
  fingerprints after a confirmed-good crash recovery) and
  `scripts/baseline-existing-db.js` (adopt a pre-ledger device into the system,
  gated by a semantic schema comparison in `scripts/semantic-schema-compare.js`).

## The parity & safety verifiers

A family of scripts (all under [scripts/](../../../scripts), all CI-gated) keeps
every schema surface honest:

| Script | Question it answers |
|---|---|
| `verify-migrations.js` | Are the migration files well-formed, contiguous, and checksum-consistent? |
| `verify-seed-replay.js` | Does replaying all migrations produce *exactly* the same schema as the blank seed? |
| `verify-db-schema-consistency.js` | Do all 7 bundled database copies match the hand-maintained schema contract (and does the main history query still use its index)? |
| `verify-runtime-schema-parity.js` | Could the boot node ever *downgrade* the seed schema (device types, triggers)? |
| `verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild.test.js` | Is the guarded `devices` rebuild still fail-closed? (The rehearsal executes the real shipped code against a real SQLite engine across four seeded scenarios.) |
| `verify-no-stray-ddl.js` | Did anyone sneak ad-hoc schema statements into the flow file or `deploy.sh`? |
| `verify-profile-parity.js` | Are the Pi 5 and Pi 4/2 payloads still byte-identical? |
