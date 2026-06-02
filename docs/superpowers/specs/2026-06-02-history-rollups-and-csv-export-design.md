# History Rollups + Nightly CSV Export — Design

Status: design for implementation planning
Scope: OSI OS edge (`osi-history-helper`, `flows.json`, SQLite, scripts) — no `osi-server`, no frontend
Date: 2026-06-02

## 1. Objective

Make long-range history visualization cheap and durable, and give each zone a downloadable
data archive, by:

1. **Persisting aggregates** in the existing (currently empty) `history_channel_rollups`
   table via a nightly scheduled job, so 7d/30d/Season charts read precomputed buckets
   instead of recomputing from raw `device_data` on every request.
2. **Keeping "today" fresh** with a per-bucket hybrid read: completed buckets come from
   rollups, the trailing open bucket is computed live from raw and merged.
3. **Exporting per-zone CSV** (raw + hourly + daily aggregates) nightly as a download/backup
   artifact, distinct from the chart read-path.

This replaces today's behaviour where **all** aggregation is recomputed live and the rollup
table is never written (verified: 0 rollup rows vs 134,337 raw rows on kaba100).

## 2. Background (current state, verified)

- `resolveAggregation` already tiers by range: raw ≤24h, 15m 24–48h, hourly 7d, daily 30d,
  daily/weekly Season.
- Each bucket computes `min/max/mean/median/latest` + coverage; the line plots
  `value = latest ?? mean` per bucket.
- `aggregateDeviceData` reads `history_channel_rollups` when `bucket_level ∈ {daily, weekly}`
  but the table is empty, so it hits the `device_data_fallback` path and recomputes live.
- The only writer of `history_channel_rollups` is a test fixture; no production job populates it.
- `history_channel_rollups` schema already has every needed column (zone_id, card_type,
  logical_source_key, channel_id, bucket_level, bucket_start/end, min/max/mean/median/latest,
  dominant_status, coverage_pct, coverage_confidence, sample_count, event_count,
  threshold_crossing_count, unit).
- Precedent nightly cron exists: `Outbox Retention Tick` inject at `0 2 * * *`.
- Download endpoints exist: `/download/database`, `/download-sensordata`, `/download-fieldtest`.

## 3. Decisions locked during brainstorming

| Topic | Decision |
| --- | --- |
| Freshness | **Nightly recompute of completed buckets + per-bucket live-merge for today.** |
| Scope | **Combined**: one nightly job writes both the rollup table and the per-zone CSV. |
| Raw retention | **Keep raw forever.** No pruning of `device_data` in this work. |
| Persisted levels | **hourly, daily, weekly.** 15m and raw stay live-only (short-range). |
| Bucket alignment | Daily/weekly buckets align to **zone-local midnight** (`irrigation_zones.timezone`). |
| Job timing | Nightly inject at **02:00 gateway-local**. Multi-timezone zones far from the gateway are a documented limitation, not handled in MVP. |
| CSV format | **Long / tidy** (one row per observation), R-readable; per zone: `raw/YYYY-MM-DD.csv`, `hourly/YYYY-MM-DD.csv`, and an appended `daily.csv`. See §4.4 for the exact column schema. |
| CSV rotation | Prune `raw/` and `hourly/` files older than `HISTORY_CSV_RAW_RETENTION_DAYS` (default 90). `daily.csv` kept indefinitely. |

## 4. Architecture

A single nightly job computes aggregates once and writes to two sinks.

```
Node-RED inject (cron 0 2 * * *)
  -> "History Rollup Tick" function node
       -> osi-history-helper.runRollupJob(db, { now })
            for each zone:
              for each card -> logical source -> channel:
                compute hourly (last ~8d), daily (last ~120d), weekly (season) buckets
                  from device_data over zone-local boundaries
                upsert into history_channel_rollups        (sink 1: chart cache)
                emit rows for CSV writer                    (sink 2: export)
            write/refresh per-zone CSV files + rotate
  -> log summary (zones, buckets upserted, files written, duration)
```

### 4.1 Files

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
  - Add `runRollupJob(db, options)` orchestrator.
  - Add `computeRollupBuckets(db, scope, level, window)` (reuses existing bucket math).
  - Add `upsertRollups(db, rows)`.
  - Add `writeZoneCsv(zone, day, rows, options)` + `rotateZoneCsv(zone, options)`.
  - Generalise the read path: `aggregateDeviceData` merges rollups (completed buckets) with a
    live-computed trailing bucket instead of all-or-nothing fallback.
- Mirror: the bcm2709 copy of `osi-history-helper/index.js` (byte-for-content).
- Modify: `conf/.../bcm2712/files/usr/share/flows.json` + bcm2709 mirror
  - Add a `History Rollup Tick` inject (cron `0 2 * * *`) + function node calling the helper.
- Modify: `scripts/test-history-helper.js` (rollup compute, upsert idempotency, hybrid merge,
  CSV content — against in-memory SQLite loaded from `database/seed-blank.sql`).
- Modify: `scripts/verify-sync-flow.js` (assert the rollup tick node exists and routes to the
  helper; no MQTT topic changes).
- No schema change (table exists). If an index is missing for the read/upsert key, add an
  additive migration + `database/seed-blank.sql` index and update
  `scripts/verify-db-schema-consistency.js`.

### 4.2 Rollup computation

- **Scope iteration:** for every zone, derive its cards (existing `deriveCardsForZone`), and for
  each card's logical source(s) and channel(s), compute buckets.
- **Levels + windows (nightly):**
  - hourly: completed hours over the last 8 days.
  - daily: completed days over the last 120 days.
  - weekly: completed ISO weeks over the current season window.
  - A 2-day lookback re-upserts recently completed buckets to absorb late-arriving rows.
- **Idempotent upsert** keyed on
  `(zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start)`:
  `INSERT … ON CONFLICT(<key>) DO UPDATE SET …`. (Add the matching UNIQUE index if absent.)
- **Boundaries:** daily/weekly bucket_start/bucket_end computed in the zone's timezone, stored
  as ISO timestamps (UTC instants of the zone-local boundaries).
- "Completed" = `bucket_end <= startOfToday(zoneTz)`; the current day's partial buckets are
  **not** persisted (they're served live).

### 4.3 Hybrid read (per-bucket merge)

`aggregateDeviceData` for hourly/daily/weekly:
1. Read rollup rows for the requested window where `bucket_end <= todayStart(zoneTz)`.
2. For the remaining window (`bucket_start >= todayStart`), compute buckets live from
   `device_data` (existing bucket math).
3. Concatenate (rollups first, live trailing) and return, tagging
   `source: 'rollups+live'` (or `'rollups'` / `'device_data'` when one side is empty).
- raw (≤24h) and 15m paths are unchanged (always live).
- If rollups are empty for a window (e.g. first night not run yet), the live path covers it —
  no worse than today.

### 4.4 CSV export

Destination: `/data/exports/<zoneUuid>/`. Created if absent. (`/data` is the persistent
partition; never touches `/data/db/farming.db`.) Per nightly run, for the just-completed
zone-local day `D`: write `raw/<D>.csv`, `hourly/<D>.csv`, and append day `D` to `daily.csv`.

#### 4.4.1 Format: long / tidy (one row per observation)

The CSV is **long (tidy) format**, not wide: every value is its own row carrying its own
metadata (source, variable, depth, unit). This is the only layout where a single `depth_cm`
column can associate with each value (a wide `swt_1,swt_2,swt_3` layout would need separate
per-column depth fields), and it is what R/tidyverse expects (`readr::read_csv` →
`dplyr::filter`).

**File conventions (R-readable):**
- UTF-8, comma-delimited, `\n` line endings, exactly one header row.
- RFC 4180 quoting: a field is double-quoted only if it contains a comma, double-quote, or
  newline (e.g. a zone/source name with a comma); embedded quotes doubled.
- Column names: lowercase `snake_case`, ASCII, no units embedded in names.
- Timestamps: **ISO 8601 UTC** with `Z` (e.g. `2026-06-02T14:03:21Z`); a separate `timezone`
  column carries the IANA zone (e.g. `Europe/Zurich`) so analysts can localise.
- Numbers: `.` decimal separator, no thousands separators, no unit suffixes.
- Missing values: empty cell (parsed as `NA` by `readr`). Never `null`/`NaN` literals.
- `variable` uses the canonical DB channel ids (`swt_1`, `swt_2`, `swt_3`, `air_temperature`,
  `relative_humidity`, `light_lux`, `ext_temperature_c`, `stem_change`, …) — stable, not
  prettified.
- `source` is the display-safe sensor name (e.g. `Chameleon 1`). **No raw DevEUI** in the CSV
  unless a future "advanced export" decision adds it (consistent with the no-DevEUI-in-normal-UI
  rule).
- `depth_cm` is numeric for depth-bearing variables (soil layers, from the Chameleon/Kiwi depth
  fields) and **empty** for variables without a depth (temperature, humidity, dendro, …).

**`raw/<D>.csv` columns:**

```
timestamp,timezone,zone,card,source,variable,depth_cm,value,unit
2026-06-02T14:03:21Z,Europe/Zurich,Zone B,soil,Chameleon 1,swt_1,5,6.24,kPa
2026-06-02T14:03:21Z,Europe/Zurich,Zone B,soil,Chameleon 1,swt_2,10,6.69,kPa
2026-06-02T14:03:21Z,Europe/Zurich,Zone B,soil,Chameleon 1,swt_3,40,6.86,kPa
2026-06-02T14:05:00Z,Europe/Zurich,Zone A,environment,Temp1,air_temperature,,21.4,degC
```

**`hourly/<D>.csv` and `daily.csv` columns** (identical schema; daily is one bucket per day):

```
bucket_start,bucket_end,timezone,zone,card,source,variable,depth_cm,unit,n,coverage_pct,mean,min,max,median,latest
2026-06-02T13:00:00Z,2026-06-02T14:00:00Z,Europe/Zurich,Zone B,soil,Chameleon 1,swt_1,5,kPa,4,100,6.30,6.18,6.41,6.29,6.24
```

- `n` = `sample_count`; `coverage_pct` may be empty when coverage is unknown.
- `daily.csv` is the long-term archive (kept indefinitely). Append is **idempotent**: if day `D`
  rows already exist, rewrite that day's rows rather than duplicating.

#### 4.4.2 Rotation & serving

- After writing, delete `raw/*.csv` and `hourly/*.csv` older than
  `HISTORY_CSV_RAW_RETENTION_DAYS` (default 90); keep `daily.csv`.
- Serving: extend the existing auth-gated `/download-sensordata` pattern to list/serve files
  under `/data/exports/<zoneUuid>/` for zones the user can access. (Download UI is out of scope;
  endpoint + auth are in scope.)

## 5. Error handling & operability

- The job is best-effort and isolated per zone: a failure on one zone logs and continues to
  the next; partial progress (upserts already committed) is fine because upserts are idempotent.
- The job is safe to run repeatedly / manually (idempotent) — useful for backfill and testing.
- Log a one-line summary: zones processed, buckets upserted per level, CSV files written/pruned,
  duration, and any per-zone errors.
- Disk safety: CSV rotation bounds `raw/`+`hourly/` growth; `daily.csv` grows ~1 row/day/channel
  (negligible).

## 6. Out of scope / guardrails

- No `osi-server`, no frontend, no MQTT/topic changes, REST-only cloud path unchanged.
- No raw-data pruning (retention = keep forever).
- No cloud sync of rollups/CSV (possible future; CSV is local-download only now).
- No 15m/raw persistence.
- Multi-timezone zones far from the gateway may have their daily rollup computed slightly early;
  documented limitation, acceptable for current deployments (all near-gateway).
- Profile parity: every helper/flows change mirrored to bcm2709 and must pass
  `scripts/verify-sync-flow.js` (chains profile parity). Never replace a provisioned
  `/data/db/farming.db`.

## 7. Risks

- **Bucket-key uniqueness:** upserts need a UNIQUE index on the rollup key, or duplicates
  accumulate. Add the index if missing (additive migration + repair).
- **Merge boundary correctness:** the rollup/live seam at `todayStart(zoneTz)` must not drop or
  double-count the boundary bucket. Covered by unit tests.
- **Nightly job cost:** recomputing 8d hourly + 120d daily + season weekly for all zones/channels
  must stay within a reasonable Pi window. Mitigated by the lookback-only recompute (not full
  history) and idempotent upserts; measured during verification.
- **Timezone bucketing:** zone-local day boundaries must match the calendar's existing
  bucketing to avoid drift between calendar and rollups (shared helper).

## 8. Verification

- `node scripts/test-history-helper.js` — rollup compute, upsert idempotency, per-bucket hybrid
  merge, CSV content, rotation, all against `:memory:` SQLite seeded from `seed-blank.sql`.
- `node scripts/verify-sync-flow.js` — rollup tick node present + routes to helper; profile
  parity holds.
- `node scripts/verify-db-schema-consistency.js` — if an index/migration is added.
- Live kaba100: run the job manually; confirm `history_channel_rollups` populates, a 30D query
  reports `source: rollups+live` (not a full raw scan), today's point still updates, and
  `/data/exports/<zone>/` contains the expected CSV files with correct rotation.
