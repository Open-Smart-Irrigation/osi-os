# SenseCAP S2120 8-in-1 Weather Station — Design Spec

**Date:** 2026-04-08  
**Status:** Approved  
**Scope:** osi-os (edge) + osi-server (cloud)

---

## Overview

Add full support for the Seeed SenseCAP S2120 8-in-1 LoRaWAN weather station. The device measures air temperature, relative humidity, barometric pressure, wind speed, wind direction, rainfall, light intensity, and UV index. Local weather data feeds into the existing prediction advisory (VPD, rainfall) and is visualised in a new device card aligned with the existing design system.

---

## Parameters

| S2120 measurement | measurementId | device_data column | Unit |
|---|---|---|---|
| Air Temperature | 4097 | `ambient_temperature` | °C |
| Air Humidity | 4098 | `relative_humidity` | % |
| Light Intensity | 4099 | `light_lux` | lux |
| Barometric Pressure | 4101 | `barometric_pressure_hpa` | hPa |
| Wind Direction | 4104 | `wind_direction_deg` | ° |
| Wind Speed | 4105 | `wind_speed_mps` | m/s |
| UV Index | 4190 | `uv_index` | UVI |
| Rain Gauge (cumulative) | 4113 | `rain_gauge_cumulative_mm` + delta chain | mm |
| Peak Wind Gust | 4213 (partial) | `wind_gust_mps` | m/s |
| Battery | 4103 | `bat_pct` | % |

Rain is sent as a cumulative counter since last device reset. Delta, per-hour, and today accumulation are derived using the same logic as LSN50 MOD9.

The existing `LOCAL_METRICS` alias system in both osi-os and osi-server already maps `ambient_temperature`, `relative_humidity`, `light_lux`, `barometric_pressure_hpa`, `wind_speed_mps`, `wind_direction_deg`, and `uv_index` — so all S2120 parameters flow into the LocalEnvironment tab automatically once stored.

---

## 1. ChirpStack Setup

- **Application:** existing `Sensors` application (same as KIWI and LSN50)
- **Device profile:** new profile `SenseCAP S2120` with the [Seeed S2120 ChirpStackV3 decoder](https://github.com/Seeed-Solution/SenseCAP-Decoder/blob/main/S2120/ChirpStack/SenseCAP_S2120_ChirpStackV3_Decoder.js) pasted into the codec field
- ChirpStack decodes binary uplinks and emits `object.data.messages[]` via MQTT before Node-RED receives them — no decoding in Node-RED

---

## 2. Database Schema Changes

### osi-os (SQLite)

**`devices` table — relax CHECK constraint:**
```sql
-- Remove old CHECK, add SENSECAP_S2120
-- Done via schema migration in Sync Init Schema + Triggers
ALTER TABLE devices ... (recreate with updated CHECK or use a migration statement)
```
The `type_id` CHECK constraint currently lists `KIWI_SENSOR`, `STREGA_VALVE`, `DRAGINO_LSN50`. Add `SENSECAP_S2120` and `TEKTELIC_CLOVER` (already in use but missing from CHECK).

**`device_data` table — new columns:**
```sql
ALTER TABLE device_data ADD COLUMN barometric_pressure_hpa REAL;
ALTER TABLE device_data ADD COLUMN wind_speed_mps REAL;
ALTER TABLE device_data ADD COLUMN wind_direction_deg REAL;
ALTER TABLE device_data ADD COLUMN wind_gust_mps REAL;
ALTER TABLE device_data ADD COLUMN uv_index REAL;
ALTER TABLE device_data ADD COLUMN rain_gauge_cumulative_mm REAL;
ALTER TABLE device_data ADD COLUMN bat_pct REAL;
```

**New junction table:**
```sql
CREATE TABLE IF NOT EXISTS weather_station_zones (
  deveui TEXT NOT NULL,
  zone_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (deveui, zone_id),
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE,
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE
);
```

**`devices.irrigation_zone_id`:** remains NULL for S2120 devices (zone assignments live in `weather_station_zones`). Existing sync triggers continue to use `irrigation_zone_id` for other device types — no change needed.

### osi-server (PostgreSQL)

- `DeviceType.java`: add `public static final String SENSECAP_S2120 = "SENSECAP_S2120";`
- New Flyway migration `V30__add_weather_station_zones.sql`:
  ```sql
  CREATE TABLE weather_station_zones (
    deveui VARCHAR(50) NOT NULL,
    zone_id BIGINT NOT NULL REFERENCES irrigation_zones(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (deveui, zone_id)
  );
  ```
- `sensor_data.data_json` (JSONB) requires no schema change — new S2120 fields stored as-is

---

## 3. Node-RED Ingest (osi-os)

New tab: **`Sensor_S2120`**

Nodes:
1. **`mqtt in`** — topic `application/+/device/+/event/up`, same broker as KIWI tab
2. **`Process S2120`** (function node):
   - Read `msg.payload.deviceInfo.devEui` to identify device
   - Look up device in SQLite: confirm `type_id = 'SENSECAP_S2120'`, get zone assignments
   - Flatten `msg.payload.object.data.messages` array-of-arrays by `measurementId`:
     - 4097 → `ambient_temperature`
     - 4098 → `relative_humidity`
     - 4099 → `light_lux`
     - 4101 → `barometric_pressure_hpa`
     - 4104 → `wind_direction_deg`
     - 4105 → `wind_speed_mps`
     - 4190 → `uv_index`
     - 4113 → `rain_gauge_cumulative_mm` (then compute delta chain)
     - 4213 → `wind_gust_mps` (from Peak Wind Gust sub-message)
     - Battery % from `messages[n]['Battery(%)']`
   - Rain delta logic: same as LSN50 MOD9 — query previous `rain_gauge_cumulative_mm` from `device_data`, compute delta, accumulate `rain_mm_today`, set `rain_delta_status`
   - Output `msg.formattedData`
3. **`Build SQL INSERT`** (function node) — inserts into `device_data` with all new columns
4. **`sqlite`** — writes to `/data/db/farming.db`
5. **`Aggregate Zone Rain/Flow`** (function node) — updates `zone_daily_environment.rainfall_mm` for all zones in `weather_station_zones` for this device

The existing OSI-Server Cloud Integration tab's wildcard subscription also receives S2120 uplinks and syncs them to the server via the outbox — no changes needed there once the new `device_data` columns are included in the trigger payload.

**`sync_outbox` trigger update:** Add new columns to the `json_object(...)` in the trigger body:
`'barometric_pressure_hpa', NEW.barometric_pressure_hpa, 'wind_speed_mps', NEW.wind_speed_mps, 'wind_direction_deg', NEW.wind_direction_deg, 'wind_gust_mps', NEW.wind_gust_mps, 'uv_index', NEW.uv_index, 'rain_gauge_cumulative_mm', NEW.rain_gauge_cumulative_mm, 'bat_pct', NEW.bat_pct`

---

## 4. Advisory Integration

### VPD priority (dendro analytics — osi-os)

Current query in `Daily Dendrometer Analytics`:
```sql
SELECT MAX(ambient_temperature), MIN(relative_humidity)
FROM device_data dd JOIN devices dv ON dv.deveui = dd.deveui
WHERE dv.irrigation_zone_id = ${zone_id}
  AND dv.type_id IN ('KIWI_SENSOR', 'TEKTELIC_CLOVER')
  AND dd.recorded_at >= ${WINDOW_START} ...
```

New two-pass logic:
1. First query `SENSECAP_S2120` via `weather_station_zones` junction — if fresh data found, use it as VPD source (`vpd_source = 'local_sensor'`)
2. If no fresh S2120 data, fall back to existing KIWI/TEKTELIC_CLOVER query

Same priority applies in `Get Zone Environment Summary` for the `local` environment building.

### Rainfall priority (osi-os)

In `Aggregate Zone Rain/Flow` (new S2120 equivalent):
- Writes `zone_daily_environment.rainfall_mm` for each assigned zone
- Sets `rain_source = 'sensecap_s2120'`
- If both S2120 and LSN50 MOD9 are assigned to the same zone, S2120 takes priority (checked by `rain_source` value when aggregating)

### osi-server (`ZoneEnvironmentService`)

- `buildLocalEnvironment`: add `SENSECAP_S2120` to device type filter
- `buildAgronomicEnvironment`: S2120 T/RH takes priority over KIWI for VPD via the existing `metricMedian(local, "air_temperature_c")` call — this works automatically since S2120 data is included in `local` metrics
- `WeatherStationZone` entity + repository for the junction table, used in device queries

---

## 5. Device Type Registration

### osi-os (`types/farming.ts`)
```typescript
export type DeviceType = 'KIWI_SENSOR' | 'STREGA_VALVE' | 'DRAGINO_LSN50' | 'TEKTELIC_CLOVER' | 'SENSECAP_S2120';
```

Add S2120-specific fields to `Device.latest_data`:
```typescript
barometric_pressure_hpa?: number | null;
wind_speed_mps?: number | null;
wind_direction_deg?: number | null;
wind_gust_mps?: number | null;
uv_index?: number | null;
rain_gauge_cumulative_mm?: number | null;
bat_pct?: number | null;
// Rain delta chain (reuses existing fields)
rain_mm_delta?: number | null;
rain_mm_today?: number | null;
rain_mm_per_hour?: number | null;
rain_delta_status?: string | null;
```

Add zone assignment fields to `Device`:
```typescript
zone_ids?: number[] | null;  // populated for SENSECAP_S2120 from weather_station_zones
zone_names?: string[] | null;
```

### osi-server (`DeviceType.java`)
```java
public static final String SENSECAP_S2120 = "SENSECAP_S2120";
```

---

## 6. React Device Card (both repos)

**New component:** `SenseCapWeatherCard.tsx` in `components/farming/`

Design (confirmed via visual companion):
- Shell: `rounded-xl p-4 border shadow-sm transition-colors bg-[var(--surface)] border-[var(--border)] hover:border-[var(--focus)]`
- Header row 1: device name + sky/blue badge (`bg-sky-100 text-sky-800`, label `S2120`) + ⚙ gear (opens zone picker) + ✕ remove
- Header row 2: monospace EUI
- Body: `grid grid-cols-2 gap-2` with 8 parameter tiles:
  - Air Temperature (orange `#ea580c`)
  - Humidity (cyan `#0891b2`)
  - Wind Speed + gust sub-label (indigo)
  - Wind Direction (violet)
  - Rain Today + last-uplink delta sub-label (blue)
  - Pressure (slate)
  - Light Intensity (amber)
  - UV Index (yellow)
- Footer: zone names (left) + battery % · last seen (right)

**Zone picker (⚙ gear):** inline config panel (same pattern as KIWI ConfigPanel) listing all irrigation zones with checkboxes. Calls new API endpoint `PUT /api/devices/:deveui/zone-assignments`.

**Device registry:**
- osi-os `IrrigationZoneCard.tsx`: add `SENSECAP_S2120` section rendering `SenseCapWeatherCard`
- osi-server `deviceRegistry.tsx`: add entry for `SENSECAP_S2120`

---

## 7. API Changes (osi-os Node-RED)

New endpoints:
- `GET /api/devices/:deveui/zone-assignments` — returns `[{ zone_id, zone_name }]`
- `PUT /api/devices/:deveui/zone-assignments` — body `{ zone_ids: number[] }`, replaces all entries in `weather_station_zones` for this device

`GET /api/devices` response: for `SENSECAP_S2120` devices, include `zone_ids` and `zone_names` arrays populated from `weather_station_zones`.

---

## 8. osi-server Sync Handling

`EdgeSyncService.upsertSensorData`: already stores all `device_data` payload fields into `sensor_data.data_json` (JSONB) — no change needed once new columns are added to the outbox trigger.

`WeatherStationZone` entity + `WeatherStationZoneRepository` added for the junction table. Zone assignment sync via bootstrap reconciliation (same pattern as other zone assignments). No dedicated sync events needed.

---

## 9. Out of Scope

- Firmware/ChirpStack profile provisioning automation (manual setup via ChirpStack UI)
- ET0 calculation using S2120 wind/radiation data (future enhancement)
- Historical rain chart in the device card (future)
