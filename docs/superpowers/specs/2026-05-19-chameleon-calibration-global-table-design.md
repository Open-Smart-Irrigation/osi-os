# Chameleon Calibration: Global Table + via.farm Integration

**Date:** 2026-05-19
**Status:** Design — pending implementation plan
**Owners:** osi-os, osi-server

## Background

Each Dragino LSN50 + Chameleon array has 3 soil water tension (SWT) sensors. Converting the measured resistance (R) to suction (kPa) requires three calibration coefficients per sensor (`a`, `b`, `c`) measured on a test rig at manufacturing time:

```
kpa = a * ln(R_kOhms) + b * R_kOhms + c
```

These coefficients live in via.farm's database (the manufacturer's lab system) and are queryable by the Chameleon array's onboard DS18B20 temperature sensor ID (16-char hex, e.g. `28F8B2B40F0000C1`).

Today, osi-os stores calibration **per device** on the `devices` table (`chameleon_swt{1,2,3}_{a,b,c}`). This conflates a property of the physical hardware with a property of the device assignment — when a Chameleon is moved between deployments, calibration must be re-entered. There is no integration with via.farm; values are either hard-coded defaults in the Node-RED helper or entered by hand.

## Goal

Move calibration to a **global** table keyed by the Chameleon array's hardware ID. osi-server caches calibration from via.farm; osi-os pulls from osi-server and bundles a snapshot in the firmware for offline-first behavior.

## Non-goals

- Editing calibration values from the GUI. They are intrinsic to the hardware.
- Periodic refresh from via.farm. Lab values don't change post-manufacturing; an admin endpoint covers re-fetch when needed.
- Backfilling historical hand-entered per-device calibration. The via.farm value is authoritative; existing per-device coefficients are dropped (V42).
- Exposing the via.farm API token to the firmware image.
- Edge-side outbox UPDATE events. The edge stays insert-only; the cloud recomputes its own historical kPa values from mirrored raw data + the global calibration table.

## Architecture

```
┌───────────────┐  GET /api/v1/sync/chameleon/         ┌─────────────────┐  GET /api/curve_params/      ┌────────────┐
│   osi-os      │  calibrations/{array_id}             │   osi-server    │  ?temperature_id_full=…       │  via.farm  │
│  (edge)       │ ───────────────────────────────────► │  (cloud)        │ ─────────────────────────────►│  (vendor)  │
│               │ ◄─────────────────────────────────── │                 │ ◄──────────────────────────── │            │
│  • SQLite     │                                      │  • Postgres     │                               └────────────┘
│  • Node-RED   │                                      │  • Spring Boot  │
│  • Bundled    │                                      │  • Cache + neg- │
│    seed       │                                      │    cache table  │
└───────────────┘                                      └─────────────────┘
```

### Calibration resolution on the edge

For each Chameleon uplink:

1. Look up `array_id` in local `chameleon_calibrations` table.
2. **Hit:** compute kPa locally using the curve, persist `device_data.swt_*` populated, emit `DEVICE_DATA_APPENDED` carrying the kPa values, persist `chameleon_readings.calibration_status='calibrated'`.
3. **Miss:** persist `device_data.swt_*=NULL` and `chameleon_readings.calibration_status='pending'`, emit `DEVICE_DATA_APPENDED` with NULL kPa, enqueue async fetch from osi-server (suppressed by `chameleon_calibration_misses` if a non-expired miss exists).
4. When a calibration fetch returns a row, run a **local backfill** that recomputes `device_data.swt_*` for past rows of that `array_id` where the values are NULL (so the local GUI graphs catch up without a cloud round-trip). The edge does **not** emit UPDATE events for the backfilled rows.
5. If osi-server returns 404 (via.farm doesn't know this array), record the miss in the local `chameleon_calibration_misses` table and mark existing pending readings as `calibration_status='unknown'`. **No silent fallback to plausible-but-wrong default coefficients.**

### Calibration resolution on the cloud

Cloud already mirrors `chameleon_readings` (raw resistances + computed `swt_1/swt_2/swt_3`) per V40 — there is no `device_data` table on the cloud; kPa lives directly on `chameleon_readings`. Cloud now also owns `chameleon_calibrations`. Cloud runs an independent recompute job whose two triggers are:

- A new calibration row enters `chameleon_calibrations` → recompute all `chameleon_readings.swt_*` rows for the matching `array_id` where the value is NULL.
- A `chameleon_readings` row arrives over sync where `swt_*` are NULL but the calibration is known → recompute.

Both sides apply the same formula to the same inputs and converge to identical values. The edge stores kPa in its `device_data.swt_*` columns; the cloud stores it in `chameleon_readings.swt_*`. The asymmetry is historical (edge uses a generic `device_data` table for all sensor types; cloud's V40 puts Chameleon-specific computed values on the Chameleon-specific readings table). The edge stays insert-only.

## Data model

### `chameleon_calibrations` (new — both osi-server Postgres and osi-os SQLite)

```sql
CREATE TABLE chameleon_calibrations (
  array_id                TEXT PRIMARY KEY,        -- 16-char uppercase hex, e.g. '28F8B2B40F0000C1'
  sensor_id               TEXT NOT NULL,           -- 4-char uppercase, positions 3,4,15,16 (1-indexed) of array_id
  sensor1_a               REAL NOT NULL,
  sensor1_b               REAL NOT NULL,
  sensor1_c               REAL NOT NULL,
  sensor1_r2              REAL,
  sensor2_a               REAL NOT NULL,
  sensor2_b               REAL NOT NULL,
  sensor2_c               REAL NOT NULL,
  sensor2_r2              REAL,
  sensor3_a               REAL NOT NULL,
  sensor3_b               REAL NOT NULL,
  sensor3_c               REAL NOT NULL,
  sensor3_r2              REAL,
  test_rig_run_start_date TEXT,                    -- ISO8601 from via.farm response
  source                  TEXT NOT NULL,           -- 'via_api' | 'bundled' | 'manual'
  fetched_at              TEXT NOT NULL            -- ISO8601 — when this row was written
);

CREATE INDEX idx_chameleon_calibrations_sensor_id ON chameleon_calibrations(sensor_id);
```

Postgres uses `DOUBLE PRECISION` instead of `REAL` and `TIMESTAMPTZ` for date columns; column names and semantics match.

### `chameleon_calibration_misses` (new — both sides)

Negative-result cache. Same shape on edge and server; 24h TTL on both:

```sql
CREATE TABLE chameleon_calibration_misses (
  array_id   TEXT PRIMARY KEY,
  last_tried TEXT NOT NULL,         -- TIMESTAMPTZ on Postgres
  reason     TEXT                   -- 'not_found' | 'invalid_response'
);
```

Any lookup older than 24h re-tries. The admin refresh endpoint ignores this cache.

### `array_id` canonicalization

`array_id` is normalized to **uppercase** at every ingress (decoder, sync worker, refresh script, seed loader, both REST endpoints). Validation regex after normalization: `^[0-9A-F]{16}$`. `sensor_id` is uppercase by construction (substring of normalized `array_id`).

### `devices` (V42 — both sides)

**Dropped columns** (9 total — 3 sensors × 3 coefficients):
```
chameleon_swt1_a, chameleon_swt1_b, chameleon_swt1_c,
chameleon_swt2_a, chameleon_swt2_b, chameleon_swt2_c,
chameleon_swt3_a, chameleon_swt3_b, chameleon_swt3_c
```

**Kept columns:**
- `chameleon_enabled` (per-device feature flag, separate from calibration)
- `chameleon_swt{1,2,3}_depth_cm` (install depth — physical install context)

### `chameleon_readings` (V42 — both sides)

**Added column:**
```sql
ALTER TABLE chameleon_readings ADD COLUMN calibration_status TEXT;
-- values: 'calibrated' | 'pending' | 'unknown'
```

### kPa cleanup (V42 — both sides)

V42 explicitly NULLs all soon-to-be-stale kPa values on each side, then lazy backfill / cloud recompute repopulates from the canonical calibration. Pre-V42 values were computed from coefficients we no longer trust; clearing them is the honest move.

**Edge (SQLite):** kPa lives on `device_data`, so NULL only rows joined to a chameleon reading:

```sql
UPDATE device_data
   SET swt_1 = NULL, swt_2 = NULL, swt_3 = NULL
 WHERE EXISTS (
   SELECT 1 FROM chameleon_readings cr
    WHERE cr.deveui = device_data.deveui AND cr.recorded_at = device_data.recorded_at
 );
```

**Cloud (Postgres):** kPa lives on `chameleon_readings` itself, so NULL every row:

```sql
UPDATE chameleon_readings SET swt_1 = NULL, swt_2 = NULL, swt_3 = NULL;
```

### SQLite DROP COLUMN compatibility

SQLite ≥ 3.35 supports `ALTER TABLE … DROP COLUMN`. The OpenWrt-bundled SQLite version is verified during implementation. If older, the migration uses the standard "create new table, copy data, drop original, rename" pattern.

## API contract

### Edge endpoints (existing edge sync JWT auth)

**Single lookup:**
```
GET /api/v1/sync/chameleon/calibrations/{array_id}
  200 → { array_id, sensor_id, sensor1_a, sensor1_b, sensor1_c, sensor1_r2,
          sensor2_a, sensor2_b, sensor2_c, sensor2_r2,
          sensor3_a, sensor3_b, sensor3_c, sensor3_r2,
          test_rig_run_start_date, source }
  404 → { error: "not_found" }            -- via.farm confirmed no curve exists for this ID
  503 → { error: "upstream_unavailable" } -- osi-server cache miss + via.farm unreachable
```

**Batch lookup:**
```
POST /api/v1/sync/chameleon/calibrations/lookup
  body: { array_ids: ["28F8B2B40F0000C1", "28DE7EC80B0000E2", ...] }
  200 → { calibrations: [...], not_found: ["..."], errors: ["..."] }
```

### Admin endpoints (osi-server only, admin auth)

```
POST /api/v1/admin/chameleon/calibrations/{array_id}/refresh
  → forces re-fetch from via.farm, overwrites cache, ignores negative cache

GET /api/v1/admin/chameleon/calibrations
  → returns all rows in chameleon_calibrations as JSON
  → consumed by scripts/refresh-chameleon-calibrations.js at release-cut time
```

### Edge-local endpoint (Node-RED, GUI-facing)

```
POST /api/devices/:deveui/chameleon/refresh-calibration
  → 1. Look up most recent array_id from chameleon_readings for this deveui
    2. Call osi-server GET /api/v1/sync/chameleon/calibrations/{array_id}
    3. INSERT/UPDATE local row; trigger local backfill
    4. Return { status: 'calibrated' | 'pending' | 'unknown', source: '...', sensor_id: '...' }
```

### `GET /api/devices/history` payload extension

Each `device_data` row in the history response gains a `calibration_status` field. Value comes from joining the matching `chameleon_readings` row by `(deveui, recorded_at)`; rows without a chameleon reading carry `null`. Lets the GUI render per-point indicators (e.g. gray dots for pre-calibration periods).

### via.farm contract (vendor)

```
GET https://via.farm/api/curve_params/?temperature_id_full={16-char-id}
Headers: Authorization: Token {VIA_FARM_API_TOKEN}
  200 + JSON body → success; body fields:
      sensor1a, sensor1b, sensor1c, sensor1R2,
      sensor2a, sensor2b, sensor2c, sensor2R2,
      sensor3a, sensor3b, sensor3c, sensor3R2,
      temperature_id_full, test_rig_run_start_date
  302 → unknown ID (treat as not_found)
  other → treat as upstream error
```

Token storage: `VIA_FARM_API_TOKEN` env var on osi-server. **Never exposed to the firmware.**

## Retired surface (V42 cleanup)

These per-device calibration paths are deleted in V42. The new calibration is intrinsic to hardware, not editable.

**osi-os GUI ([web/react-gui](web/react-gui)):**
- [src/services/api.ts:368](web/react-gui/src/services/api.ts#L368) — `ChameleonConfigPayload` interface (delete)
- [src/services/api.ts:419](web/react-gui/src/services/api.ts#L419) — `setChameleonConfig` method (delete)
- [src/types/farming.ts:113-119](web/react-gui/src/types/farming.ts#L113) — the 9 `chameleon_swt{1,2,3}_{a,b,c}` typed fields (delete; keep `chameleon_swt{1,2,3}_depth_cm` and `chameleon_enabled`)
- [src/components/farming/DraginoChameleonSwtSection.tsx](web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx) — remove calibration-coefficient inputs and the `setChameleonConfig` call (line 202); replace with the read-only status block defined under "UI changes"

**osi-os Node-RED (flows.json on both bcm2712 and bcm2709):**
- `chameleon-config-http` HTTP-in node (delete)
- `chameleon-config` function node (delete)
- `chameleon-config-auth-fn` auth function node (delete)

**osi-server:**
- Any controller / handler that backs `PUT /api/devices/{deveui}/chameleon-config` is verified absent or removed during implementation. (No `SET_CHAMELEON_CONFIG` sync command type exists — confirmed.)
- The 9 calibration columns on `devices` are dropped via V42 SQL migration. Any DTO / entity field referencing them is removed.

## osi-server components

- `ChameleonCalibrationsController` — REST handlers for the lookup, batch, and admin endpoints
- `ChameleonCalibrationsService` — cache-aside logic: reads `chameleon_calibrations`, falls through to `ViaFarmClient` on miss, persists positive results, persists negative results in `chameleon_calibration_misses`
- `ChameleonRecomputeService` — listens for inserts to `chameleon_calibrations` and to `chameleon_readings`, runs the recompute described under "Calibration resolution on the cloud"
- `ViaFarmClient` — `RestTemplate`/`WebClient` wrapper; configured with `VIA_FARM_BASE_URL` (default `https://via.farm/api`), `VIA_FARM_API_TOKEN`, 5s timeout
- `ChameleonCalibrationsRepository`, `ChameleonCalibrationMissesRepository` — Spring Data JPA repositories

### Sensor ID derivation

```java
public static String deriveSensorId(String arrayId) {
  String normalized = arrayId.toUpperCase();
  if (!normalized.matches("^[0-9A-F]{16}$")) {
    throw new IllegalArgumentException("invalid array_id");
  }
  return normalized.substring(2, 4) + normalized.substring(14, 16);
}
```

Verified: `28F8B2B40F0000C1` → `F8C1` ✓

### Server-side tests

- Unit: `deriveSensorId` happy + reject (length, non-hex); via.farm response parser (200, 302, malformed body, missing fields); recompute math against fixture rows
- Integration: cache hit; cache miss + via.farm hit; cache miss + via.farm not_found (writes miss row, returns 404); cache miss + via.farm 5xx/network (returns 503, does **not** write miss row); admin refresh ignores miss table
- Negative-cache TTL: lookup with an entry older than 24h re-attempts via.farm
- Recompute: insert calibration → previously-NULL `chameleon_readings.swt_*` rows for that array_id populate to expected kPa; insert `chameleon_readings` for an array with cached calibration → corresponding `chameleon_readings` row's `swt_*` populates

## osi-os components

### Updated `osi-chameleon-helper` (Node module)

- New function `calibrationFromArrayId(db, arrayId)` SELECTs from `chameleon_calibrations` and returns `{ swt1: {a,b,c}, swt2: {a,b,c}, swt3: {a,b,c} } | null`
- `chameleon_enabled` stays an input to `buildChameleonSwtMetrics` (sourced from the device row, separate from calibration). Helper signature becomes `buildChameleonSwtMetrics(sample, { enabled, calibration })`.
- Remove `DEFAULT_CALIBRATION`. Missing calibration → kPa stays NULL. No silent fallback.
- `resistanceOhmsToKpa()` formula unchanged.
- All array_id inputs are uppercased before SQL parameterization.

### Sync worker (Node-RED, in `flows.json`)

Augment the existing 30s sync poll with a calibration-fetch step. The query excludes both cached calibrations and non-expired misses:

```sql
SELECT DISTINCT array_id
  FROM chameleon_readings
 WHERE array_id IS NOT NULL
   AND array_id NOT IN (SELECT array_id FROM chameleon_calibrations)
   AND array_id NOT IN (
     SELECT array_id FROM chameleon_calibration_misses
      WHERE last_tried > datetime('now', '-24 hours')
   );
```

If the list is non-empty, POST to `/api/v1/sync/chameleon/calibrations/lookup`. For each returned `calibrations` row: INSERT into local `chameleon_calibrations`, mark matching `chameleon_readings` rows as `calibration_status='calibrated'`, run local backfill (below). For each `not_found` array_id: INSERT into local `chameleon_calibration_misses` and mark matching `chameleon_readings` rows as `calibration_status='unknown'`. `errors` are ignored (next poll retries naturally).

### Local backfill

When a calibration is newly inserted on the edge, recompute `device_data.swt_*` for past readings of that array_id where the value is NULL. The recompute joins `chameleon_readings` (which carries the raw resistances) to `device_data` by `(deveui, recorded_at)` and applies the kPa formula per row.

Implementation: a single Node-RED function that iterates the matching `chameleon_readings` rows in JavaScript and emits parameterized UPDATEs (clearer than a single CTE; the join cardinality is bounded by readings-per-array-id which is small). UPDATEs run inside one transaction. The edge does **not** emit outbox events for these UPDATEs (insert-only sync semantics).

### Manual refresh endpoint (Node-RED HTTP node)

```
POST /api/devices/:deveui/chameleon/refresh-calibration
```

Replaces the deleted `chameleon-config-http` endpoint. Reads the most recent `array_id` for the deveui, calls osi-server's single-lookup endpoint, INSERTs locally, runs local backfill, returns `{ status, source, sensor_id }`.

### Bundled seed

- File: `database/seeds/chameleon-calibrations.sql` (checked in)
- Format: `INSERT OR IGNORE INTO chameleon_calibrations (...) VALUES (...);`, sorted by `array_id` for stable diffs, each row tagged `source='bundled'`
- Generator: `scripts/refresh-chameleon-calibrations.js` calls the admin `GET /api/v1/admin/chameleon/calibrations` endpoint on osi-server and writes the file
- Applied to the seed `farming.db` during the existing build pipeline that produces `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db` (and the bcm2709 counterpart)

### Edge-side tests

- New `scripts/verify-chameleon-calibration.js`:
  1. Insert a `chameleon_readings` row with an `array_id` not in `chameleon_calibrations`; assert decode persists with NULL kPa and `calibration_status='pending'`
  2. Insert the calibration row directly; run the backfill; assert `device_data.swt_*` populated for the historical row
  3. Insert a fresh reading with the same array_id; assert kPa populated via lookup path
  4. Insert a miss row (older than 24h); assert sync worker re-attempts the array_id
  5. Insert a miss row (younger than 24h); assert sync worker skips the array_id
  6. Mixed case input array_id (`28de7ec80b0000e2`) normalizes to uppercase before SELECT/INSERT
- Extend `verify-sync-flow.js` to cover the new sync endpoint
- Update `verify-lsn50-chameleon-persistence.js` for the new lookup-by-array-id path

## UI changes (`web/react-gui`)

In the LSN50/Chameleon device settings page, replace the calibration coefficient inputs with:

- **Array ID:** monospace, small, copyable — `28F8B2B40F0000C1`
- **Sensor ID:** large, prominent — `F8C1` (matches the label printed on the Chameleon hardware)
- **Status badge:** `Calibrated` (green) | `Pending sync…` (yellow) | `Calibration unavailable` (gray)
- **Refresh calibration** button — calls the edge endpoint
- **Depth fields:** `swt1_depth_cm`, `swt2_depth_cm`, `swt3_depth_cm` — remain editable (install context)

**No calibration coefficients shown anywhere in the GUI.** The values are an implementation detail of the conversion.

Chart rendering uses the new per-row `calibration_status` from history payloads to dim points whose status is `'pending'` or `'unknown'`.

## Build-time / release-cut process

Documented in [docs/versioning-workflow.md](../../versioning-workflow.md):

1. Maintainer runs `node scripts/refresh-chameleon-calibrations.js` against the live osi-server
2. Reviews the diff of `database/seeds/chameleon-calibrations.sql`
3. Commits the updated snapshot as part of the release PR
4. Builds firmware via existing `make` flow

## Migration & rollout

- V42 runs on both osi-os (SQLite) and osi-server (Postgres) in the same release. The two schemas move together because the response shape changes.
- Live gateways: ALTER TABLE statements run via the existing schema-sync step on first boot after upgrade. The bundled seed populates `chameleon_calibrations` for known arrays. The V42 `device_data` NULL pass clears soon-to-be-stale kPa values. The next uplink triggers lazy fetch for any array_id without bundled calibration; once fetched, local backfill repopulates historical rows.
- Live cloud: cloud-side V42 NULLs `chameleon_readings.swt_*` directly (cloud stores kPa on `chameleon_readings`, not `device_data`). Cloud recompute repopulates from the global `chameleon_calibrations` table as calibrations land (either via.farm-sourced or sync'd from edges that bundle them).
- Demo Pis (Silvan, kaba100) and the Uganda production Pi have hand-entered per-device calibration today. Those values are **discarded** in V42. Operators verify post-upgrade that `chameleon_calibrations` has rows for each live array_id; if a row is missing and via.farm returns 404, follow up with the lab to register the array.
- Risk: if via.farm is unreachable when a live gateway boots into V42 firmware and its array isn't in the bundled seed, that gateway reports NULL kPa until connectivity returns. Mitigation: run the release-cut snapshot script shortly before each release.

## Open questions / follow-ups

- **OpenWrt SQLite version check.** Confirm whether the bundled SQLite supports `ALTER TABLE … DROP COLUMN`; pick V42 migration variant accordingly. (Verified during implementation, before writing the migration.)
- **GitHub issue #51 follow-on.** Unrelated; ships separately.

## References

- via.farm endpoint verified: `GET https://via.farm/api/curve_params/?temperature_id_full=28DE7EC80B0000E2` → 200 OK + JSON
- Existing edge helper: [conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js](../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js)
- Existing osi-server migrations: V40 (`chameleon_full_mirror`), V41 (`chameleon_data_invalid`)
- Existing schema: [database/seed-blank.sql](../../../database/seed-blank.sql)
