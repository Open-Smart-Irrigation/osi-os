# Edge SQLite History Retention

## Bug: startup devices rebuild can delete sensor history

Observed on a Pi 4 edge hub after offline operation: `device_data` and
`chameleon_readings` contained only recent rows, while `sync_outbox` still held
older append events. This made the live tables look like a short retention cache,
even though `/data/db/farming.db` is intended to be the canonical full local
history store.

Root cause: the Node-RED `Sync Init Schema + Triggers` startup function rebuilt
the parent `devices` table with `ALTER TABLE devices RENAME TO devices_old`,
`ALTER TABLE devices_new RENAME TO devices`, and `DROP TABLE devices_old` while
SQLite foreign-key enforcement was enabled on the shared OSI database helper.
History tables such as `device_data`, `chameleon_readings`, and
`dendrometer_readings` reference `devices(deveui) ON DELETE CASCADE`. During the
swap, dropping `devices_old` can cascade-delete rows from those child tables.

The bug was present in the shared full-image runtime payload for:

- Pi 5 target: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Pi 4/400/3/2 target: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`

## Fix plan

1. Add a regression guard to `scripts/verify-sync-flow.js` that fails unless the
   startup `devices` table rebuild is fenced with `PRAGMA foreign_keys=OFF`
   before creating/swapping `devices_new`, and `PRAGMA foreign_keys=ON` after the
   final `DROP TABLE IF EXISTS devices_old`.
2. Patch both full-image targets with the same fence so Pi 4 and Pi 5 stay in
   payload parity.
3. Keep the existing post-swap FK self-heal for older DBs whose child-table
   definitions may already reference `devices_old`.
4. Before repairing a field DB, back up `/data/db/farming.db` and sidecar files.
   Reconstruct missing primary history rows from `sync_outbox.payload_json` only
   on a copy first, then apply the validated import to the live DB.

## Detection SQL

Run on the edge DB copy or on the Pi after making a backup:

```sql
SELECT 'device_data' AS source,
       count(*) AS rows,
       min(recorded_at) AS first_at,
       max(recorded_at) AS last_at
  FROM device_data
UNION ALL
SELECT 'chameleon_readings',
       count(*),
       min(recorded_at),
       max(recorded_at)
  FROM chameleon_readings
UNION ALL
SELECT 'outbox_device_data',
       count(*),
       min(json_extract(payload_json, '$.recorded_at')),
       max(json_extract(payload_json, '$.recorded_at'))
  FROM sync_outbox
 WHERE aggregate_type = 'DEVICE_DATA'
UNION ALL
SELECT 'outbox_chameleon',
       count(*),
       min(json_extract(payload_json, '$.recorded_at')),
       max(json_extract(payload_json, '$.recorded_at'))
  FROM sync_outbox
 WHERE aggregate_type = 'CHAMELEON_READING';
```

If the live history tables start much later than the corresponding outbox
events, the primary history was likely cascade-deleted during a prior startup
schema rebuild.

## Field recovery notes

- Do not restart Node-RED on an affected unpatched hub before taking a backup.
- Do not replace `/data/db/farming.db` on a provisioned Pi.
- Recover from `sync_outbox` only for append-only history aggregates where the
  payload contains the original `recorded_at` and sensor values.
- Validate row counts, timestamp ranges, and duplicate keys on a DB copy before
  importing recovered rows.
- After upgrade, run the detection SQL again and confirm new readings continue
  to accumulate in the primary history tables across a Node-RED restart.

## Prevention rule

Any future startup migration that rebuilds a parent table referenced by
`ON DELETE CASCADE` child tables must avoid the parent drop/rename pattern or
must fence the swap with `PRAGMA foreign_keys=OFF` and restore
`PRAGMA foreign_keys=ON` immediately after the final drop. The sync verifier
guards the known `devices` rebuild case.

## History Sync V1 Rollout Guardrails

- Do not remove raw history outbox triggers on a field gateway until shadow
  history sync has completed a full raw-table backfill.
- Do not import recovered outbox history into `/data/db/farming.db` without a
  timestamped backup of `/data/db/`, `/srv/node-red/`, and
  `/usr/lib/node-red/gui/`.
- Do not prune server-extra edge-sourced rows without two manifest confirmations
  or explicit operator approval.
- Keep legacy `/edge/events` and `/edge/bootstrap` compatibility until every
  supported OSI OS image advertises `history_sync_v1`.

## Sync outbox retention and size cap

`sync_outbox` is the edge-to-cloud event queue. Delivered rows are already in the
cloud and can be time-pruned; undelivered rows must normally be retained so the
edge can catch up after an offline window.

Two environment knobs control the daily `Prune Sync Outbox` job:

| Env var | Default | Purpose |
|---|---:|---|
| `OSI_OUTBOX_RETENTION_DAYS` | `30` | Deletes delivered rows older than this many days. Undelivered rows are not affected by this time-prune. |
| `OSI_OUTBOX_MAX_ROWS` | `50000` | Caps total queue size. Values below `1000` are floored to `1000` so a bad setting cannot aggressively evict telemetry. |

When the total-row cap is exceeded, the job evicts only oldest telemetry-class
rows, delivered rows first and then undelivered rows by `occurred_at`.
Evictable telemetry aggregates are `DEVICE_DATA`, `CHAMELEON_READING`,
`DENDRO_READING`, `DENDRO_DAILY`, `ZONE_ENVIRONMENT`, and
`ZONE_RECOMMENDATION`.

Protected aggregates are never evicted by the cap: `IRRIGATION_EVENT`,
`SCHEDULE`, `ZONE`, `DEVICE`, and `GATEWAY_LOCATION`. If protected rows alone
leave the table over `OSI_OUTBOX_MAX_ROWS`, the job evicts nothing further,
logs `outbox size cap exceeded by protected rows: ...`, bumps `error_counts`
through the Node-RED catch path, and keeps accepting writes. Until item 0.2
adds `errors_total` to gateway health, this condition is visible on-device in
the Node-RED log rather than remotely in heartbeat telemetry.

Operator response for the protected-over-cap signal: investigate why the
gateway is not delivering events to the cloud. The telemetry runaway is bounded
on disk, but a protected backlog above the cap means schedules, zones, devices,
gateway location, or irrigation events are not draining.

## Gateway health telemetry (CPU / memory / load / fan / throttling)

Since ordered migration `database/migrations/ordered/0002__gateway_health.sql`
(2026-07, osi-os #68), every gateway persists its own 60 s heartbeat locally in
`/data/db/farming.db`. This closes the gap found during the 2026-06-28 kaba100
Chameleon-1 I2C outage analysis: before this, CPU temperature/load/fan state
was live MQTT telemetry only, so "was the Pi throttling when the gap started?"
could not be answered from the edge database.

### What is stored

| Table | Grain | Retention (default) | Written by |
|---|---|---|---|
| `gateway_health_samples` | 1 row / 60 s heartbeat | 14 days (`OSI_HEALTH_RAW_RETENTION_DAYS`) | `Persist Gateway Health` node, own 60 s inject `gateway-health-sample-tick` |
| `gateway_health_hourly` | 1 row / gateway / closed UTC hour, `min/mean/max` + `sample_count` | 365 days (`OSI_HEALTH_HOURLY_RETENTION_DAYS`) | `Gateway Health Rollup` node, daily at 02:10 |

Columns per sample: `gateway_device_eui`, `sampled_at` (ISO UTC), `cpu_temp_c`,
`mem_percent`, `load_1/5/15`, `fan_value` (PWM 0–255, NULL when no fan), and
`throttled` — the raw Raspberry Pi firmware `get_throttled` bitfield read from
`/sys/devices/platform/soc/soc:firmware/get_throttled` (NULL when the kernel
does not expose it). Bits: `0x1` under-voltage now, `0x2` ARM frequency capped
now, `0x4` currently throttled, `0x8` soft temperature limit now; the same bits
shifted left 16 (`0x10000`…`0x80000`) mean "has occurred since boot".

The rollup job is idempotent (`INSERT OR REPLACE` over every closed hour still
inside the raw window), so nights where the Pi was powered off self-heal on the
next run. A **gap in `gateway_health_samples` rows is itself evidence** that
Node-RED (or the Pi) was down for that window. This data is local-only: it is
NOT synced to OSI Server in v1 (the cloud already receives live heartbeats).

### How to query it

Pis do not ship the `sqlite3` CLI. Either copy the DB off the Pi
(`scripts/download-farming-db.sh`) and query locally, or run node on the Pi:

```
node -e "const s=require('/srv/node-red/node_modules/sqlite3');const d=new s.Database('/data/db/farming.db');d.all('SELECT COUNT(*) AS n, MAX(sampled_at) AS last FROM gateway_health_samples',(e,r)=>{console.log(e?String(e):JSON.stringify(r));d.close();});"
```

Hourly overview for an outage window (per gateway + time window):

```sql
SELECT hour_start, sample_count,
       ROUND(cpu_temp_c_max,1)  AS cpu_max_c,
       ROUND(mem_percent_max,0) AS mem_max_pct,
       ROUND(load_1_max,2)      AS load1_max,
       fan_value_max, throttled_max
FROM gateway_health_hourly
WHERE gateway_device_eui = '0016C001F11766E7'
  AND hour_start >= '2026-06-27T00:00:00Z'
  AND hour_start <  '2026-06-29T00:00:00Z'
ORDER BY hour_start;
```

Minute-level detail around a suspected gap (raw window, last 14 days):

```sql
SELECT sampled_at, cpu_temp_c, mem_percent, load_1, fan_value, throttled
FROM gateway_health_samples
WHERE gateway_device_eui = '0016C001F11766E7'
  AND sampled_at >= '2026-06-28T08:30:00Z'
  AND sampled_at <  '2026-06-28T10:30:00Z'
ORDER BY sampled_at;
```

"Was it throttling?" summary for a window:

```sql
SELECT COUNT(*) AS samples,
       SUM(CASE WHEN (throttled & 0x4) != 0 THEN 1 ELSE 0 END) AS throttled_now_samples,
       MAX(cpu_temp_c) AS max_temp_c
FROM gateway_health_samples
WHERE gateway_device_eui = '0016C001F11766E7'
  AND sampled_at >= '2026-06-28T08:00:00Z'
  AND sampled_at <  '2026-06-28T12:00:00Z';
```

Heartbeat/sampling gaps > 5 min (downtime candidates):

```sql
SELECT prev_at, sampled_at,
       ROUND((julianday(sampled_at) - julianday(prev_at)) * 1440, 1) AS gap_min
FROM (SELECT sampled_at, LAG(sampled_at) OVER (ORDER BY sampled_at) AS prev_at
      FROM gateway_health_samples
      WHERE gateway_device_eui = '0016C001F11766E7')
WHERE prev_at IS NOT NULL
  AND (julianday(sampled_at) - julianday(prev_at)) * 1440 > 5
ORDER BY sampled_at;
```

### Rollout to a live Pi

`deploy.sh` applies migration 0002 automatically (`ensure_gateway_health_schema`,
which fetches and executes the migration file — additive-only, idempotent)
before the operator restarts Node-RED. Post-deploy check: run the node
one-liner above ~2 minutes after `/etc/init.d/node-red restart` and expect
`n >= 1` with a fresh `last` timestamp. The first hourly rollups appear after
the next 02:10 tick (or trigger `Gateway Health Rollup Tick` manually in the
Node-RED editor).
