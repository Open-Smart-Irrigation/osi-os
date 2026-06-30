# Chameleon SWT History Repair

Chameleon soil water tension history has two local stores:

- `device_data.swt_1`, `device_data.swt_2`, `device_data.swt_3` are canonical
  for the local history API, rollups, CSV export, and cloud `DEVICE_DATA`
  sync events.
- `chameleon_readings.swt_1`, `chameleon_readings.swt_2`,
  `chameleon_readings.swt_3` are diagnostic mirrors next to the raw Chameleon
  payload, status flags, array id, and compensated resistances.

If a Chameleon row is calibrated, not invalid, has no I2C/timeout/open-channel
faults, and has a matching `chameleon_calibrations.array_id`, both stores
should contain the same kPa values.

## Failure Mode

A historical outage can appear in the analysis chart even though
`chameleon_readings` shows `calibration_status='calibrated'` and no I2C fault
when the canonical `device_data.swt_*` values are `NULL`.

Two repository-side causes are guarded now:

1. `chameleon_readings` must have `swt_1`, `swt_2`, and `swt_3` columns, and the
   Chameleon insert/outbox path must persist those diagnostic kPa values.
2. `deploy.sh` schema repair must not mutate `device_data.swt_*`. A prior V42
   cleanup nulled `device_data.swt_*` for every row that joined a Chameleon
   reading. That is unsafe on repeat deploys because calibrated canonical history
   may already be correct.

Historical `UPDATE`s do not fire the live `AFTER INSERT ON device_data` outbox
trigger. Any field repair that changes `device_data.swt_*` and must catch up
the cloud analysis mirror needs explicit corrected `DEVICE_DATA_APPENDED` rows
in `sync_outbox`.

## Repair Script

Use `scripts/repair-chameleon-swt-history.js`.

The script:

- runs as a dry-run by default;
- requires `--apply --backup-ok` before writing;
- computes kPa with `osi-chameleon-helper`;
- updates both `device_data.swt_*` and `chameleon_readings.swt_*`;
- with `--queue-sync`, queues corrected `DEVICE_DATA_APPENDED` events only for
  repaired canonical `device_data` rows;
- does not treat an existing outbox event with `NULL` SWT payload values as a
  duplicate.

## Field Procedure

Create a backup first:

```bash
TS="$(date -u +%Y%m%dT%H%M%SZ)"
ssh root@<gateway-ip> "mkdir -p /data/db/backups/osi-os-$TS && sqlite3 /data/db/farming.db \".backup '/data/db/backups/osi-os-$TS/farming.db.pre-chameleon-swt-repair'\" && sqlite3 /data/db/farming.db 'PRAGMA quick_check;'"
```

Copy the repair script:

```bash
scp scripts/repair-chameleon-swt-history.js root@<gateway-ip>:/tmp/repair-chameleon-swt-history.js
ssh root@<gateway-ip> 'chmod +x /tmp/repair-chameleon-swt-history.js'
```

Dry-run:

```bash
ssh root@<gateway-ip> "node /tmp/repair-chameleon-swt-history.js \
  --db /data/db/farming.db \
  --deveui <chameleon-device-eui> \
  --since <first-affected-iso-timestamp> \
  --gateway <gateway-eui> \
  --queue-sync"
```

Apply only after the dry-run counts match the expected gap:

```bash
ssh root@<gateway-ip> "node /tmp/repair-chameleon-swt-history.js \
  --db /data/db/farming.db \
  --deveui <chameleon-device-eui> \
  --since <first-affected-iso-timestamp> \
  --gateway <gateway-eui> \
  --queue-sync \
  --apply \
  --backup-ok"
```

Verify:

```sql
SELECT dd.recorded_at,
       dd.swt_1 AS device_swt_1,
       dd.swt_2 AS device_swt_2,
       dd.swt_3 AS device_swt_3,
       cr.swt_1 AS chameleon_swt_1,
       cr.swt_2 AS chameleon_swt_2,
       cr.swt_3 AS chameleon_swt_3,
       cr.i2c_missing,
       cr.timeout,
       cr.calibration_status
  FROM device_data dd
  JOIN chameleon_readings cr
    ON upper(cr.deveui) = upper(dd.deveui)
   AND cr.recorded_at = dd.recorded_at
 WHERE upper(dd.deveui) = upper('<chameleon-device-eui>')
   AND dd.recorded_at >= '<first-affected-iso-timestamp>'
 ORDER BY dd.recorded_at
 LIMIT 20;
```

Then verify pending sync catch-up:

```sql
SELECT COUNT(*) AS pending_corrected_swt_events
  FROM sync_outbox
 WHERE aggregate_type = 'DEVICE_DATA'
   AND op = 'DEVICE_DATA_APPENDED'
   AND delivered_at IS NULL
   AND (
        json_extract(payload_json, '$.swt_1') IS NOT NULL OR
        json_extract(payload_json, '$.swt_2') IS NOT NULL OR
        json_extract(payload_json, '$.swt_3') IS NOT NULL
       );
```

After sync delivery, rebuild local history rollups if the UI still reads an
older aggregate cache.
