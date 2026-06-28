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
