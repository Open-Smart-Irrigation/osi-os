# Chameleon Integration

The VIA Chameleon module is a 3-channel resistive soil-moisture sensor array that plugs into a Dragino LSN50 via I²C. This document covers the full integration stack: hardware protocol, LSN50 firmware, edge pipeline, calibration system, cloud mirror, and operational procedures.

For the raw I²C protocol, vendor command set, and wiring details see [docs/hardware/chameleon-reference.md](hardware/chameleon-reference.md).

---

## 1. Architecture

```
LSN50 firmware (STM32)
  │  I²C @ 400 kHz
  └─► VIA Chameleon module
        raw + temp-compensated ohm readings
        DS18B20 array ID (8 bytes)

LSN50 LoRaWAN uplink (FPort 2, V2 payload)
  │
  ▼
ChirpStack (kaba100)
  │  MQTT application/+/device/+/event/up
  ▼
Node-RED LSN50 decoder
  │  decode object fields → _chameleonDecoded
  │  lookup array_id in chameleon_calibrations
  │  compute kPa inline if calibration present
  ▼
SQLite farming.db
  ├── device_data      (swt_1/2/3 kPa, or NULL if pending)
  └── chameleon_readings (r_ohm_comp/raw, calibration_status, comp_pending)

30s sync poll
  ├── calibration-missing-query → calibration-batch-fetch → osi-server
  │     POST /api/v1/sync/chameleon/calibrations/lookup
  │     → osi-server queries via.farm → stores result → responds
  │     → edge inserts into chameleon_calibrations
  │     → calibration-local-backfill recomputes swt_* for pending rows
  └── sync outbox → osi-server CHAMELEON_READING_APPENDED events

osi-server (Spring Boot + Postgres)
  ├── chameleon_calibrations (via.farm cache)
  └── chameleon_readings (swt_1/2/3 computed by ChameleonRecomputeService)
        ▲
        └── ViaFarmClient → GET https://via.farm/api/curve_params/?temperature_id_full=…
```

---

## 2. LSN50 Firmware Payload (V2)

The custom firmware (`feature/chameleon-i2c-reader` in `Project-OSI/LoRa_STM32`) uses FPort 2 with a 32-byte frame. The ChirpStack codec decodes this into the `object` fields that Node-RED reads.

### V2 object fields

| Field | Type | Meaning |
|---|---|---|
| `Chameleon_Payload_Version` | int | Must be `2` to trigger the V2 path |
| `Chameleon_Status_Flags` | int | Raw status byte |
| `Chameleon_Data_Invalid` | bool | Status bit 0x01 — measurement fault |
| `Chameleon_I2C_Missing` | bool | Chameleon not found on I²C bus |
| `Chameleon_Timeout` | bool | Measurement timed out |
| `Chameleon_Temp_Fault` | bool | DS18B20 fault (-127 °C sentinel) |
| `Chameleon_ID_Fault` | bool | DS18B20 ID all-FF sentinel |
| `Chameleon_CH1_Open` / `_CH2_Open` / `_CH3_Open` | bool | 10 MΩ open-circuit sentinel |
| `Chameleon_TempC` | float | DS18B20 temperature (°C) |
| `Chameleon_R1_Ohm_Comp` / `R2` / `R3` | int | Temperature-compensated resistance (Ω) |
| `Chameleon_R1_Ohm_Raw` / `R2` / `R3` | int | Uncompensated resistance (Ω) |
| `Chameleon_Array_ID` | string | DS18B20 ROM code, 16-char hex, e.g. `28F8B2B40F0000C1` |

`comp_pending` (status bit 0x80) is set by the firmware when it has raw readings but hasn't yet applied its internal temperature correction. The edge decoder stores this flag in `chameleon_readings.comp_pending`.

### V1.5 (legacy)

Earlier firmware does not include `Chameleon_Payload_Version`. The decoder falls back to the V1 path (no `data_invalid`, no `comp_pending`). Devices still running V1.5 can coexist with V2 devices on the same gateway.

---

## 3. kPa Conversion Formula

```
kPa = a × ln(R_kΩ) + b × R_kΩ + c
```

Three `(a, b, c)` triples per Chameleon array — one per soil channel. Coefficients are measured on a calibration test rig by VIA at manufacturing time and stored in via.farm keyed by the DS18B20 ROM code (`array_id`).

- Input: compensated resistance in **kΩ** (`R_ohm_comp / 1000`).
- Domain: `R_kΩ > 0`. The 10 MΩ open-circuit sentinel (`Chameleon_CH*_Open`) must be filtered before conversion.
- Range: can produce negative kPa on saturated soil (down to ≈ −9 kPa). This is valid.
- `r2` (R² fit quality) is stored but not used for filtering.

---

## 4. Edge Schema

### `chameleon_calibrations`
Global calibration table keyed by array hardware ID. Shared across all devices that use the same physical array.

```sql
CREATE TABLE chameleon_calibrations (
  array_id                TEXT PRIMARY KEY,  -- 16-char uppercase hex
  sensor_id               TEXT NOT NULL,     -- chars 3-4 + 15-16 of array_id
  sensor1_a / _b / _c     REAL NOT NULL,
  sensor1_r2              REAL,
  sensor2_a / _b / _c     REAL NOT NULL,
  sensor2_r2              REAL,
  sensor3_a / _b / _c     REAL NOT NULL,
  sensor3_r2              REAL,
  test_rig_run_start_date TEXT,
  source                  TEXT NOT NULL,     -- 'via_api' | 'bundled'
  fetched_at              TEXT NOT NULL
);
```

### `chameleon_calibration_misses`
Negative-result cache. Arrays in this table are not retried for 24 hours.

```sql
CREATE TABLE chameleon_calibration_misses (
  array_id   TEXT PRIMARY KEY,
  last_tried TEXT NOT NULL,
  reason     TEXT   -- 'not_found'
);
```

### `chameleon_readings`
One row per uplink. Raw resistance values are the source of truth; kPa is derived.

Key columns: `deveui`, `recorded_at`, `array_id`, `calibration_status` (`'calibrated'` | `'pending'` | `'unknown'`), `comp_pending`, `data_invalid`, `r1_ohm_comp/raw`, `r2_ohm_comp/raw`, `r3_ohm_comp/raw`, `temp_c`, `i2c_missing`, `timeout`, `temp_fault`, `id_fault`.

### `device_data`
`swt_1` / `swt_2` / `swt_3` (kPa) hold the computed soil-water tension for the Chameleon's three channels. NULL when calibration is pending.

---

## 5. Calibration Pipeline

### Ingest (per uplink)
1. Decoder extracts `Chameleon_Array_ID` from the uplink object.
2. `Apply Config` looks up the array_id in `chameleon_calibrations`.
3. **Hit** → compute kPa inline, write `device_data.swt_*`, set `calibration_status='calibrated'`.
4. **Miss** → write `device_data.swt_*=NULL`, set `calibration_status='pending'`.

### Async fetch (every 30 seconds)
The sync polling cycle runs `calibration-missing-query`:

```sql
SELECT DISTINCT upper(cr.array_id)
FROM chameleon_readings cr
WHERE cr.array_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM chameleon_calibrations cc WHERE cc.array_id = upper(cr.array_id))
  AND NOT EXISTS (
    SELECT 1 FROM chameleon_calibration_misses cm
    WHERE cm.array_id = upper(cr.array_id)
      AND datetime(cm.last_tried) > datetime('now', '-24 hours')
  )
```

If non-empty, `calibration-batch-fetch` POSTs to osi-server:

```
POST /api/v1/sync/chameleon/calibrations/lookup
{ "array_ids": ["28DE7EC80B0000E2", ...] }
→ { "calibrations": [...], "not_found": [...], "errors": [] }
```

Auth: reads `server_url` and `server_sync_token` from `users.server_sync_token` (same pattern as all other sync nodes — NOT from env vars).

### Local backfill
After a new calibration row is inserted, `calibration-local-backfill` recomputes `device_data.swt_*` for all existing rows of that `array_id` where `swt_1 IS NULL`. Uses the same kPa formula. Runs inside a single transaction. The edge does **not** emit sync outbox events for these updates (insert-only sync semantics).

### Not-found
If osi-server returns an array in `not_found`: insert into `chameleon_calibration_misses`, mark matching `chameleon_readings` rows as `calibration_status='unknown'`. Retried after 24h.

### Manual refresh
The "Refresh calibration" button in the GUI calls `POST /api/devices/:deveui/chameleon/refresh-calibration` on the local Node-RED API. This bypasses the 24h miss cache and forces an immediate single-array lookup from osi-server.

---

## 6. osi-server Calibration

### Via.farm lookup
`ViaFarmClient` calls:

```
GET https://via.farm/api/curve_params/?temperature_id_full={array_id}
Authorization: Token {VIA_FARM_API_TOKEN}
```

`VIA_FARM_API_TOKEN` is set in `docker-compose.yml` on the VPS. It is never exposed to edge devices.

- HTTP 200 → found, parse and cache in `chameleon_calibrations`
- HTTP 302/404 → not found, insert `chameleon_calibration_misses`
- Network error / 5xx → `Unavailable` — does not write a miss row (retried next time)

### ChameleonRecomputeService
Recomputes `chameleon_readings.swt_1/2/3` on the server side from its own `chameleon_calibrations` table. Triggers on:
- A new calibration row enters the server table
- A `chameleon_readings` row arrives via sync where `swt_*` are NULL but calibration is known

Both edge and server apply the same formula to the same inputs. Values converge but may differ slightly due to floating-point rounding.

### Sync endpoints (edge auth)
```
POST /api/v1/sync/chameleon/calibrations/lookup   -- batch lookup
GET  /api/v1/sync/chameleon/calibrations/{id}     -- single lookup
```

### Admin endpoints
```
GET  /api/v1/admin/chameleon/calibrations         -- dump all (used by refresh-chameleon-calibrations.js)
POST /api/v1/admin/chameleon/calibrations/{id}/refresh  -- force re-fetch from via.farm
```

---

## 7. Sync Deduplication Fix

**Commit `de4a36a` (osi-server).** Before this fix, `DEVICE_DATA_APPENDED`, `DENDRO_READING_APPENDED`, and `CHAMELEON_READING_APPENDED` events all used only `device_eui` as the watermark key. The second reading from the same device in the same bootstrap window collided with the first and was silently dropped with `equal_version_payload_conflict`.

Fix: `resourceTypeFromOp` now dispatches these three ops to dedicated types (`DEVICE_DATA_ROW`, `DENDRO_ROW`, `CHAMELEON_ROW`) before the prefix fallbacks, and `resourceIdForType` uses the composite `aggregateKey` (`deveui|recorded_at`) as the resource ID. `EdgeOwnershipService` was updated to extract the device EUI from the composite key for these types.

---

## 8. Calibration Token Bug

**Commit `587cd866` (osi-os).** `calibration-batch-fetch` and `chameleon-refresh-fetch` were reading `env.get('SYNC_TOKEN')` — an environment variable that is never set on production devices. The sync token lives in `users.server_sync_token` in the database. This caused every calibration lookup to silently return `null` since the feature was written (commit `50f38670`). Calibrations that appeared to be working had been inserted manually in a prior session, not by the flow.

Fix: both nodes now read `server_url` and `server_sync_token` from the `users` table with env vars as fallback, consistent with all other sync nodes.

---

## 9. Bundled Seed

`database/seeds/chameleon-calibrations.sql` can be pre-populated at release time:

```bash
OSI_ADMIN_TOKEN=<token> node scripts/refresh-chameleon-calibrations.js
```

This calls `GET /api/v1/admin/chameleon/calibrations`, writes `INSERT OR IGNORE` statements sorted by `array_id`, and tags rows `source='bundled'`. Applied to all seed `farming.db` files by `scripts/apply-chameleon-calibration-seed.js`.

If the seed is empty (as it currently is), devices rely entirely on the runtime async fetch from osi-server on first contact. Any array registered in via.farm will be picked up within one 30s poll cycle of the first uplink.

---

## 10. Operational Procedures

### Simulate an uplink (testing)

1. Insert a test device:
```sql
INSERT INTO devices (name, deveui, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at)
  SELECT 'Test', 'A84041CAFECAFE01', 'DRAGINO_LSN50', id, 3, 1, datetime('now'), datetime('now')
  FROM users WHERE username='admin' LIMIT 1;
```

2. Publish via MQTT (topic `application/{app_id}/device/{deveui}/event/up`):
```json
{
  "deviceInfo": {
    "devEui": "a84041cafecafe01",
    "deviceProfileName": "OSI DRAGINO LSN50",
    "applicationId": "..."
  },
  "fPort": 2, "fCnt": 1,
  "object": {
    "Chameleon_Payload_Version": 2,
    "Chameleon_Status_Flags": 0,
    "Chameleon_Data_Invalid": false,
    "Chameleon_I2C_Missing": false,
    "Chameleon_Timeout": false,
    "Chameleon_Temp_Fault": false,
    "Chameleon_ID_Fault": false,
    "Chameleon_CH1_Open": false, "Chameleon_CH2_Open": false, "Chameleon_CH3_Open": false,
    "Chameleon_TempC": 24.5,
    "Chameleon_R1_Ohm_Comp": 85000, "Chameleon_R2_Ohm_Comp": 91000, "Chameleon_R3_Ohm_Comp": 79000,
    "Chameleon_R1_Ohm_Raw": 87000, "Chameleon_R2_Ohm_Raw": 93000, "Chameleon_R3_Ohm_Raw": 81000,
    "Chameleon_Array_ID": "28F8B2B40F0000C1",
    "BatV": 3.6, "TempC1": 24.5, "ADC_CH0V": 0.0
  },
  "time": "2026-05-21T12:00:00.000Z"
}
```

3. Check results:
```sql
SELECT swt_1, swt_2, swt_3, recorded_at FROM device_data WHERE deveui='A84041CAFECAFE01';
SELECT array_id, calibration_status, r1_ohm_comp FROM chameleon_readings WHERE deveui='A84041CAFECAFE01';
```

4. Clean up: `DELETE FROM devices/device_data/chameleon_readings WHERE deveui='A84041CAFECAFE01'`

### Check calibration state

```sql
-- What's calibrated on the edge
SELECT array_id, sensor_id, source, fetched_at FROM chameleon_calibrations ORDER BY fetched_at DESC;

-- What's pending
SELECT DISTINCT array_id FROM chameleon_readings WHERE calibration_status='pending';

-- Recent miss cache
SELECT array_id, last_tried, reason FROM chameleon_calibration_misses;
```

### Check server-side values

```sql
-- On osi-server Postgres
SELECT d.device_eui, cr.array_id, cr.swt_1, cr.swt_2, cr.swt_3, cr.calibration_status, cr.recorded_at
FROM chameleon_readings cr JOIN devices d ON d.id = cr.device_id
WHERE d.gateway_device_eui = '0016C001F11766E7'
ORDER BY cr.recorded_at DESC LIMIT 10;
```

### Verify kPa formula manually

```js
const r_kohm = r_ohm_comp / 1000;
const kpa = a * Math.log(r_kohm) + b * r_kohm + c;
```

---

## 11. Live Devices (kaba100)

| Device | EUI | Array ID | Sensor ID | Status |
|---|---|---|---|---|
| Chameleon 1 | `A84041A75D5E7CFB` | `28DE7EC80B0000E2` | DEE2 | calibrated |
| Chameleon 2 | `A84041CE3F5ECF52` | `28F8B2B40F0000C1` | F8C1 | calibrated |

Both devices uplink every ~5 minutes. kPa values appear in the GUI under the device's Chameleon section. Both are synced to osi-server and visible in the server's `chameleon_readings` table.

---

## 12. References

- Hardware protocol & I²C command set: [docs/hardware/chameleon-reference.md](hardware/chameleon-reference.md)
- Firmware repo: `Project-OSI/LoRa_STM32`, branch `feature/chameleon-i2c-reader`
- Edge helper module: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`
- Persistence test: `scripts/verify-lsn50-chameleon-persistence.js`
- Calibration seed script: `scripts/refresh-chameleon-calibrations.js`
- osi-server: `ViaFarmClient.java`, `ChameleonCalibrationsController.java`, `ChameleonRecomputeService.java`
