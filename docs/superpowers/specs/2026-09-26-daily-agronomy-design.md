# Daily agronomy record design

**Status:** Proposed for implementation (sub-project 2 of 4; builds on `feat/weather-provider-store`)

**Decision:** The edge owns reference evapotranspiration (ET0) and crop water demand (ETc). It writes one row per zone and completed local day into `zone_daily_agronomy` from three ET0 tiers (a local weather station through FAO-56 Penman-Monteith, the stored provider hours, Hargreaves-Samani from local temperature), with a crop coefficient (Kc) from the full FAO-56 crop catalogue and FAO-56 growth stages, frozen per row. The Water tab's "Last 7 days" plot draws each completed day's demand as a tick; today keeps the forecast. Every explanation lives in a tooltip. The cloud adopts the same catalogue, vocabulary and formulas in sub-project 4; until then a linked gateway may show the drift banner, which Phil accepted on 2026-09-26 because no customer depends on it.

## Intent

Phil wants the daily crop demand stored and shown for every day of the week, not today's value repeated seven times, and he wants the edge to keep working without internet when a weather station is connected. The FAO-56 calculation becomes the default agronomy on the gateway; the AquaCrop-based prediction advisor stays experimental and keeps its own crop subset.

Success means:

- each zone has one row per completed local day with `et0_mm`, its tier and source, the Kc with crop and stage, and `etc_mm`, or a null with a stated reason;
- a gateway without internet still fills those rows for zones served by a local station;
- the plot shows seven distinct demand values with today marked as a forecast, and a missing day marked as missing;
- the crop and stage settings offer the full FAO-56 catalogue and vocabulary, and the numbers behind them are the same JSON the cloud will copy;
- no explanatory sentence appears on the page outside a tooltip.

## Decisions

| Topic | Decision | Basis |
|---|---|---|
| ET0 owner | The edge computes ET0; the cloud computes the same way for its own zones (sub-project 4). Nothing syncs in this sub-project. | Offline-first product; a station gives every FAO-56 input except radiation, which comes from light intensity. |
| ET0 tiers per zone-day | 1. `station_fao56`: daily FAO-56 Penman-Monteith from the assigned station's hourly aggregates. 2. `<provider>_hourly_sum`: sum of the stored provider hours. 3. `hargreaves_station`: Hargreaves-Samani from the station's daily minimum and maximum temperature. Else null with a reason. The first complete tier wins. | Same tiers the cloud's `Et0Resolver` uses, in the same order. |
| Daily provider ET0 | Sum of hourly `et0_mm` over the local day, only when every hour of that day is present and non-null (23, 24 or 25 hours). MeteoSwiss's daily column is a different formula (7 to 15 % lower at Payerne) and is not used. | Open-Meteo daily vs hourly sum: ratio 1.000 to 1.005. The four peak hours carry up to 68 % of a day. |
| Which days | The last 7 completed local days, plus any earlier day without a row or with a null `et0_mm`, back to the oldest stored hour and at most 92 days. Never today. | Outages longer than 7 days are refilled by the weather store; the writer must follow. |
| Today | The Water tab keeps the forecast ET0 × Kc for today (`waterNeededTodayMm`), taken from the forecast day whose date is today in the zone's timezone, and only while the forecast cache is live (`cacheStatus === 'live'`) or was fetched today; otherwise today's demand is null with reason `demand_unknown`. Offline across midnight, today is unavailable, never yesterday's value (`buildAgronomic` takes `daily[0]` today, which reproduced yesterday's ET0 in a probe). | Phil, 2026-09-26. |
| Kc source of truth | `docs/contracts/agronomy/crop-kc.json`: the FAO-56 Table 12 catalogue (Kc ini, mid, end, plus the crop group) and the growth-stage vocabulary. Copied into the edge helper `osi-crop-kc`, the GUI, and later osi-server, each checked by a byte-parity verifier and a shared vector file. | Three copies drifted before (7 crops in the GUI, 55 in the cloud, a broken stage table on the edge). |
| Growth stages | Stored keys `initial`, `development`, `mid_season`, `late_season`, `dormancy`, or null for unset. Kc: initial → ini, development → mid, mid_season → mid, late_season → end (the FAO-56 table values; the ramps of figure 25 need a stage start date and table 11 lengths, which is sub-project 4's daily interpolation on both sides; Phil's ruling 2026-09-26, replacing the stage-mean ruling of the final fix wave), dormancy → 0.25 for every crop, null → mid with `kc_source = 'fao56_crop_stage_unset'`. Legacy keys are migrated (`budbreak → initial`, `fruitset → development`, `veraison → mid_season`, `harvest → late_season`, `default → null`) and still accepted on read. | The GUI's "Bud break / flowering" mapped to the initial Kc; a maize grower choosing flowering got 0.30 instead of 1.20. |
| Crop without a catalogue entry (`other`, unknown, null) | Stage heuristic `initial .45, development .70, mid_season .90, late_season .60, dormancy .25, null .75`, `kc_source = 'heuristic_phenology'`. | The cloud's `PHENO_KC`, re-keyed. |
| Kc history | `kc`, `kc_source`, `crop_type`, `phenological_stage` are written when a row first gets a non-null `et0_mm` and never changed afterwards; `et0_mm`, `et0_source`, `etc_mm = et0_mm × kc` heal on every run. | Phil, 2026-09-26; four of five reviewers. A stage change never rewrites what the farmer irrigated against. |
| Linked gateways | The edge overlays its completed days onto the cloud bundle's rows; today stays the cloud's value with `kcSource: 'server'`. The drift banner may show until sub-project 4. | Approach A; Phil, 2026-09-26. |
| GUI copy | Tooltips only. No note, banner or caption is added anywhere. | Phil, 2026-09-26. |

## Current state

The edge computes ETc at read time from the Open-Meteo forecast's day-0 ET0 and a stage table whose keys (`bud_break`, `cell_division`, …) the GUI never sends, so four of six stages fall to 0.75 (`osi-zone-env/index.js` lines 17–25 and 429–433). `crop_type` is never read on the edge. The GUI's crop selector offers the seven crops of the AquaCrop catalogue (`predictionCropCatalog.json`). The cloud carries about 55 crops in `ZoneEnvironmentService.CROP_KC` and uses the stage heuristic for every zone that has a gateway.

`zone_daily_agronomy` exists (migration 0060) with no reader or writer. The 7-day rows of the Water tab come from `buildWaterHistory` inside the `zone-env-fn` node, pinned by golden vectors under `docs/contracts/zone-env/`, and carry no demand field; a day without a rain row is written as 0 mm rain. In shared-server mode the cloud bundle supplies the rows and the edge splices in its irrigation fields only (`mergeDailyIrrigationSplit`).

A SenseCAP S2120 delivers air temperature, humidity, light intensity (lux), UV index, wind speed and direction, pressure and rain every uplink, into `device_data`. Stations are assigned to zones through `weather_station_zones`. `gateway_locations.altitude_m` holds the gateway's elevation when a fix exists.

The dendrometer daily job (`dendro-compute-fn`, cron `0 8 * * *`) computes a zone's local day with a one-shot offset that returns 0 on any error, which silently produces UTC days; the Node build has ICU timezone data but English locale data only, so `Intl.DateTimeFormat(...).formatToParts` is safe and `format()` strings are not.

## Data model

One additive ordered migration (`0061__daily_agronomy.sql`; renumbered together with 0060 if the RAK branch lands first) and one data migration for the stage keys.

```sql
-- risk: additive
ALTER TABLE zone_daily_agronomy ADD COLUMN crop_type TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN phenological_stage TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN et0_tier TEXT;            -- 'station_fao56' | 'provider_hourly_sum' | 'hargreaves_station'
ALTER TABLE zone_daily_agronomy ADD COLUMN et0_station_id TEXT;      -- station deveui (station tiers), MeteoSwiss station id (provider tier), NULL for Open-Meteo
ALTER TABLE zone_daily_agronomy ADD COLUMN location_key TEXT;        -- the provider location a provider tier used
ALTER TABLE zone_daily_agronomy ADD COLUMN hours_present INTEGER;
ALTER TABLE zone_daily_agronomy ADD COLUMN expected_hours INTEGER;
ALTER TABLE zone_daily_agronomy ADD COLUMN null_reason TEXT;         -- 'no_source' | 'partial_day' | 'mixed_station' | 'unknown_station' | 'pending' | 'no_location'

ALTER TABLE weather_provider_hours ADD COLUMN station_id TEXT;      -- MeteoSwiss station of that hour, null for a grid provider

CREATE TABLE IF NOT EXISTS weather_station_hours (
  deveui                TEXT NOT NULL REFERENCES devices(deveui) ON DELETE CASCADE,
  hour_start            TEXT NOT NULL,
  air_temperature_c     REAL,   -- mean of the samples
  air_temperature_min_c REAL,
  air_temperature_max_c REAL,
  relative_humidity_pct REAL,
  wind_speed_mps        REAL,
  pressure_hpa          REAL,
  light_lux             REAL,   -- mean
  global_radiation_wm2  REAL,   -- light_lux / LUX_PER_WM2 (contract constant)
  rain_mm               REAL,   -- sum of rain_mm_delta
  sample_count          INTEGER NOT NULL,
  computed_at           TEXT NOT NULL,
  PRIMARY KEY (deveui, hour_start)
);
```

```sql
-- risk: data
-- 0062__fao56_stage_keys.sql: legacy vine-flavoured stage keys become FAO-56
-- growth stages. Only live rows whose normalised value changes are touched,
-- and each of those gets a new sync_version and updated_at, because the zone
-- outbox trigger emits ZONE_CONFIG_UPSERTED for a stage change and the cloud
-- rejects a changed payload that carries a version it already holds.
UPDATE irrigation_zones
   SET phenological_stage = CASE lower(trim(phenological_stage))
         WHEN 'budbreak' THEN 'initial' WHEN 'bud_break' THEN 'initial'
         WHEN 'fruitset' THEN 'development' WHEN 'cell_division' THEN 'development' WHEN 'cell_expansion' THEN 'development'
         WHEN 'veraison' THEN 'mid_season' WHEN 'fruit_maturation' THEN 'mid_season'
         WHEN 'harvest' THEN 'late_season' WHEN 'post_harvest' THEN 'late_season'
       END,
       sync_version = sync_version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE lower(trim(COALESCE(phenological_stage,''))) IN
       ('budbreak','bud_break','fruitset','cell_division','cell_expansion','veraison','fruit_maturation','harvest','post_harvest')
   AND deleted_at IS NULL;
```

The database default `phenological_stage TEXT DEFAULT 'default'` stays as it is: SQLite cannot change a column default without a table rebuild, and a rebuild is not worth it. `'default'`, `NULL` and any unknown value all mean "stage not set" at every boundary (`normalizeStage` in `osi-crop-kc`, the GUI selector, the zone PUT handler), and the data migration leaves `'default'` rows untouched so they emit nothing. `weather_station_hours` and `zone_daily_agronomy` do not sync; the zone resource's `phenological_stage` already syncs edge to cloud, and the cloud accepts the FAO keys today (`STAGE_KC_INDEX`). Retention is unbounded and documented in `docs/operations/edge-history-retention.md` (365 rows per zone per year; 8,760 per station per year).

Existing MeteoSwiss hours have no `station_id`. The weather tick's gap rule treats a MeteoSwiss hour with a null `station_id` inside its 7-day lookback as missing, so recent history is refetched with provenance; older hours keep a null `station_id` and the provider tier rejects such a day with `null_reason = 'unknown_station'` rather than assuming today's station. Sub-projects 1 and 2 ship in one release, so no gateway holds weeks of such rows.

## The agronomy contract (`docs/contracts/agronomy/`)

- `crop-kc.json`: `{ "version": 1, "stages": [...], "crops": [{ "id": "maize", "group": "cereals", "label": "Maize", "kc_ini": 0.30, "kc_mid": 1.20, "kc_end": 0.35, "variant_of": null, "fao_row": "Maize, Field (grain)" }, ...] }` transcribed row by row from FAO-56 Table 12 (Allen et al. 1998), every row of the table, one entry per row, identifiers in snake case. Where the table gives several rows for one crop (wine versus table grapes; deciduous orchards with or without ground cover and with or without frost; berries; citrus by canopy cover; conifers and so on), each row is its own entry with an explicit `variant_of` pointing at the crop's default entry, and the default is stated in the README with the agronomic reason. The cloud's 55 identifiers are kept as the default entries so synced `crop_type` values stay valid; where a cloud identifier maps to a Table 12 row, the table's values replace the cloud's and the README lists each as "corrected from cloud". Documented defaults: `grapevine` = wine grapes (0.30 / 0.70 / 0.45; the cloud's 0.85 mid-season value is the table-grape row); `apple` (and `pear`, `cherry`, `plum`) = "no ground cover, killing frost"; `citrus` = "70 % canopy, no ground cover"; `olive` = "40 to 60 % ground cover"; `berries` = "bushes". The GUI lists variants under their crop; the implementer transcribes, the agronomist reviewer checks the transcription against the table before merge. The prediction advisor's seven crops keep their identifiers; its catalogue lists which of them it can predict.
- `et0-vectors.json`: input/output pairs for the daily FAO-56 Penman-Monteith (FAO-56 equation 6) with an explicit wind height (equation 47), Hargreaves-Samani (equation 52), and the lux-to-radiation conversion, with the values the cloud's `WeatherMath.fao56Et0` (10 m wind) and `hargreavesEt0` produce today for the same inputs, so the JavaScript port is proven against the Java before the Java is touched.
- `kc-vectors.json`: every crop × every stage × unset, plus `other`, unknown and null crops.
- `README.md`: the constant `LUX_PER_WM2 = 120` (daylight luminous efficacy; to be replaced by the demo gateway's calibration if it differs by more than 10 %), the stage vocabulary and its legacy mapping, the labels per crop group shown in the GUI, and the rule that this directory is the source and every copy is checked by `scripts/verify-agronomy-contract.js`.

Copies: `conf/.../node-red/osi-crop-kc/crop-kc.json` (edge), `web/react-gui/src/agronomy/crop-kc.json` (GUI), and later `osi-server`'s two copies. The verifier compares bytes and runs the vector files against the edge implementation; the GUI's vitest suite runs the same vector files against its TypeScript.

## Components

### 1. `osi-crop-kc` (new helper)

`resolveKc({ cropType, phenologicalStage }) → { kc, kcSource, cropId, stage }` and `normalizeStage(value)` (legacy keys accepted). Required relatively by `osi-zone-env` and `osi-agronomy-daily` (sibling requires are precedent: `osi-network-api`, `osi-journal-replication`). `osi-zone-env`'s `deriveCropCoefficient` and `KC_BY_STAGE` are deleted; `buildAgronomic` and the forecast days take `resolveKc` and report `cropCoefficientSource` as the resolver names it.

### 2. `osi-weather-provider` (extended)

- Exports `zoneLocations(db, deploymentDefault) → [{ zone, provider, locationKey, latitude, longitude, timezone }]`, used by `runTick` and by the daily writer, so location resolution has one implementation. It returns every zone with coordinates; a zone with `weather_source = 'local'` has `provider` and `locationKey` null, `runTick` skips it, and the daily writer keeps it for the station tiers.
- Stores `station_id` on every MeteoSwiss hour, and treats a MeteoSwiss hour with a null `station_id` inside the 7-day gap lookback as missing, so it is refetched with provenance (bounded backfill; older hours are never assigned a station retrospectively).

### 3. `osi-station-hours` (new helper): station uplinks to hours

`aggregateStationHours({ db, nowIso, warn })` reads `device_data` rows of `SENSECAP_S2120` devices assigned to at least one zone, groups them per completed UTC hour, and upserts `weather_station_hours` with mean, minimum and maximum temperature, mean humidity, mean wind, mean pressure, mean lux, `global_radiation_wm2 = light_lux / LUX_PER_WM2`, summed rain, and the sample count. An hour with no sample gets no row. The window is the last 48 hours plus any missing hour back 7 days; the upsert is conditional on a changed value. Before any write, a clock before 2024-01-01 or more than 24 hours behind the newest stored hour skips the run (`skipped: 'clock_behind_store'`, one warning): a Pi 4 that reboots offline stamps uplinks with a stale clock, and an hour older than 48 hours is never aggregated again. Warnings are logged when a problem starts or changes (instants and digits masked). Chained after the weather tick (section 6).

### 4. `osi-agronomy-daily` (new helper): the daily writer

- `localDayWindow(dateLocal, timezone) → { hourStarts[], fallback }`: the UTC hours from D−1 to D+2 whose `formatToParts` date in the zone's timezone is D, one cached formatter per timezone; 23, 24 or 25 hours. Timezone through `normalizeTimezone(zone.timezone)`; an invalid timezone falls back to UTC and the zone is listed once per run in `tzFallback` (there is no gateway-level timezone setting to compare against).
- `completedLocalDays(nowIso, timezone, count = 7)` and `daysNeedingWork(existingRows, ...)`: the 7 latest completed days by the clock, plus older days with no row or a null `et0_mm`, bounded below by the oldest stored hour of any source (station or provider) and at most 92 days. Clock validity is a separate check, the same as the weather tick's: a run whose `now` is more than 24 hours before the newest stored hour of any source is skipped with a warning (`clock behind the store`), and on every run the zone's rows dated today or later by the clock are deleted (a clock that ran ahead left them; today is never written). Within a valid clock, every day in range gets a row, so an ordinary outage produces explicit `no_source` or `partial_day` rows rather than silence. A day that ended less than 3 hours ago and is incomplete is written with `null_reason = 'pending'`, not `'partial_day'`.
- Tier 1 `station_fao56`: needs a station assigned to the zone and, for every hour of the local day, a `weather_station_hours` row whose mandatory inputs are all non-null: `air_temperature_min_c`, `air_temperature_max_c`, `relative_humidity_pct`, `wind_speed_mps`, `global_radiation_wm2`. An hour whose samples all lacked one of those fields fails the day for this tier, whatever its `sample_count`, and a daily radiation sum of 0 fails it too (a dead or covered light sensor). So does a sum below 0.06 × Ra (FAO-56 equation 21; a Swiss fog day in December still passes) or a 0 in any hour whose extraterrestrial radiation (equation 28, from the zone's latitude and longitude) exceeds 1 MJ/m²; such a day falls to the next tier, and to `partial_day` if every tier fails. Inputs are the day's minimum and maximum temperature, mean humidity, mean wind with its measurement height, the sum of radiation converted to MJ/m²/day, elevation from `gateway_locations.altitude_m` (else from the station's mean pressure through FAO-56 equation 7 solved for the elevation, `z = (293 / 0.0065) × (1 − (P_kPa / 101.3)^(1/5.26))`, else null which the formula tolerates), latitude from the zone, day of year; result through the contract's `fao56Et0`. Two stations assigned to one zone: the one with the most complete hours that day; its deveui is recorded in `et0_station_id`. A zone without coordinates (neither its own nor its gateway's) gets rows with `null_reason = 'no_location'`. Each tier's daily result is clamped at 0, as the cloud's `max(0, …)` does. `hours_present` and `expected_hours` describe the tier that was attempted last (tier 3 when all fail), and `null_reason` names it; a provider reason (`mixed_station`, `unknown_station`) reports the provider tier's counts.
- Wind height is an explicit input everywhere. The contract's `fao56Et0` takes `windSpeedMs` and `windHeightM` and applies FAO-56 equation 47 (`u2 = uz × 4.87 / ln(67.8 × z − 5.42)`; at 2 m the factor is 1). The cloud's Java today assumes 10 m; sub-project 4 gives it the same parameter. Sources: Open-Meteo `wind_speed_10m` is 10 m; MeteoSwiss `fkl010h0` is the station's anemometer height, taken as 10 m; a SenseCAP S2120 is on a pole, taken as 2 m through the contract constant `STATION_WIND_HEIGHT_M = 2` (a per-device height is sub-project 3's device settings). The vector file holds the same physical wind expressed at 2 m and at 10 m with equal ET0, and a 10 m vector that reproduces the Java's current output.
- Tier 2 `provider_hourly_sum`: the location's hours over the day, all present and non-null, all from one `station_id` for MeteoSwiss (else `null_reason = 'mixed_station'`), which is recorded in `et0_station_id`; `et0_source` is `open_meteo_hourly_sum` or `meteoswiss_hourly_sum`. The day's sum is clamped at 0 (MeteoSwiss hours can be negative); the hourly rows stay as delivered.
- Tier 3 `hargreaves_station`: the station day's minimum and maximum temperature, non-null in every hour of the local day; humidity, wind and radiation may be missing.
- Kc through `osi-crop-kc`, frozen per row as one snapshot. The writer reads the existing row inside the zone's transaction. A row is "initialised" when its `kc` is not null; an initialised row keeps `kc`, `kc_source`, `crop_type` and `phenological_stage` exactly as stored, null values included, whatever the zone's settings say now. An uninitialised row that receives a non-null `et0_mm` gets the snapshot from the resolver at that moment. The effective Kc is chosen once in code (the stored one if initialised, else the resolved one), `etc_mm` is computed in code from it, and every column is written explicitly: no `COALESCE` per column, no arithmetic on stored columns in SQL. `INSERT ... ON CONFLICT(zone_id, date) DO UPDATE SET <every column> = excluded.<column> WHERE <any stored value differs>`, one facade `transaction()` per zone. `computed_at` therefore means "last changed", and the first null-to-valid update sets `et0_mm`, `etc_mm` and the snapshot together.
- Hours are read once per (location key, station set, timezone) group.
- Returns `{ zones, days, written, unchanged, nulls: [{ zoneId, date, reason, present, expected }], tzFallback: [zoneIds] }`; the node sets `node.status` from it and warns only when a zone's reason changes.
- Module-level in-flight guard; a run that starts while one is running returns `skipped: 'in_flight'`.

### 5. Zone environment summary and overlay

- `osi-zone-env` gains `buildWaterDaily({ envRows, estimatedByDate, agronomyRows, zone, todayIso, waterNeededTodayMm, kcSourceToday, stationNames })`, extracted from the node's `buildWaterHistory`; the node keeps the queries. A day without a rain row gets `rainMm: null`, never 0 (the cloud's F115 rule).
- Each day row gains `demandMm`, `demandSource` (`calculated` | `forecast` | null), `et0Mm`, `et0Source`, `et0Tier`, `et0StationId`, `et0StationName` (the station's device name for a deveui, the MeteoSwiss id itself otherwise), `kc`, `kcSource`, `cropType`, `phenologicalStage`, `hoursPresent`, `expectedHours`, `nullReason`. Today: `demandMm = waterNeededTodayMm`, `demandSource: 'forecast'`, `kcSource`, `kc`, `cropType`, `phenologicalStage` and the forecast `et0Mm` from the agronomic block (`'server'` in shared mode, where the gateway's own ET0 and Kc are dropped), and `nullReason: 'demand_unknown'` when there is no demand. The water block gains `todayDate`, today's date in the zone's timezone, so the GUI knows which row is today.
- `mergeDailyIrrigationSplit(sharedDaily, localDaily, todayIso)` copies the new fields from local rows for dates before `todayIso`; today keeps the cloud's `waterNeededTodayMm` only when the bundle's last date equals `todayIso` (a stale bundle across midnight otherwise falls back to the local forecast, labelled `demandSource: 'forecast'`, `kcSource: 'local'`, and takes `rainTodayMm`, `rainSource`, `balanceTodayMm`, `next24hRainMm` and the action from the gateway too, so the tile shows one day). `resolveWaterAction` answers `demand_unknown` when today's demand is null and keeps `balance_unknown` for a zone without area or efficiency.
- Golden vectors: the two existing cases re-captured, plus `crop-table-kc` (maize, seeded rows including one null day and one pending day), `shared-server`, and `shared-server-stale`. The field names and enum values above are the shape sub-project 4's `WaterDay` must emit.

### 6. Flow nodes

- `weather-provider-fn`'s single output is wired to a new thin node `station-hours-fn` (loads `osiLib.require('station-hours')`), whose output is wired to `agronomy-daily-fn` (loads `osiLib.require('agronomy-daily')`). Each skips when the incoming payload carries `skipped: 'in_flight'`, opens the facade, runs its helper, warns on failure, closes in `finally`. The weather node forwards a thrown error as `payload: { weatherFailed: true }` and the station node forwards its clock skip as `payload.stationSkipped`, so the daily writer, which has its own clock guard, still runs; all three nodes show a status line (the daily node yellow only when a zone's latest completed day has no ET0, red on a failure). No new inject: yesterday becomes complete on the first weather tick after the last hour is published, and station hours close with the same cadence. The nodes measure 1,467, 1,525 and 1,515 characters after the final fix wave; the size ratchet gets the measured allowance.
- The three helpers are registered on every delivery surface; `verify-osi-lib-db-caller-binding.js` gains policies for `weather-provider`, `station-hours` and `agronomy-daily`, each with a facade-contract test.

### 7. GUI

Zone settings:
- The crop selector offers the full catalogue from `crop-kc.json`, grouped by FAO group (a native grouped select, which jumps to a crop by its typed first letters); the prediction advisor's fields stay as they are and its tooltip says which crops it supports. The stage selector offers `initial`, `development`, `mid_season`, `late_season`, `dormancy`; its labels come from the crop group ("Initial (bud break)" for vines and orchards, "Initial (emergence)" for annuals), and a tooltip beside the stage label gives the FAO-56 meaning. Legacy values load as their mapped stage.

Water tab (the W53 port folded in, tooltips only):
- `waterChart.ts` with `buildWaterChartRows`, `waterChartSeries`, `waterChartMaxMm`; the "Last 7 days" title, legend, y-axis floor, station-rain series and source fields (`rainSource`, `rainStation`, `dailyRainSource`); the edge's measured/estimated irrigation split kept.
- Demand is a horizontal tick across each day's slot (not a fourth bar); today's tick is dashed and its x-axis label reads "Today"; a dashed vertical boundary precedes today. A null past day shows a grey dash at the baseline. A negative daily ET0 draws at 0 and the tooltip shows the value.
- Tooltip per day: the supply values as today; one demand line ("Crop demand: 4.2 mm (forecast)" / "(calculated)" / "no data (weather record incomplete)" / "pending"), one source line ("Open-Meteo model · Kc 1.20 (maize, mid-season)", "Station demo-s2120 · FAO-56", "MeteoSwiss PAY · Kc 0.75 (stage not set)"), and for today the line "rain and irrigation so far; demand is the forecast for the whole day". Provider attribution (Open-Meteo CC BY 4.0, MeteoSwiss) appears in this tooltip and in the Weather tab's source label; no credit line under the plot.
- The "Water needed today" tile keeps its label; its tooltip says "Forecast for the whole day" and names the source. No caption is added.
- Legend entries and bar names use locale keys; new keys in en, de-CH, fr, it, es, pt, and in English for lg. The cloud's strings for `lastSevenDays`, `tooltipDemand`, `stationCredit`, `rainFromStation`, `rainFromWeather` and the two balance-source lines are reused verbatim, and its `rainUnknown` / `demandUnknown` strings under the edge keys `zone.water.reason.rain_unknown` / `demand_unknown`.
- The chart renders when any of rain, irrigation or a calculated demand day exists. Demand needs no zone area.

### 8. Sub-project boundaries

- Sub-project 3 (data view): `weather_station_hours` and `weather_provider_hours` as history sources, the `et0_mm` channel, and the cloud-to-edge `weather_source` round trip found by the sync review (the cloud sends it in `UPSERT_ZONE_CONFIG`, the edge drops it).
- Sub-project 4 (cloud): copies `docs/contracts/agronomy/`, deletes the gateway-specific heuristic branch and the 55-crop Java table, adopts the FAO stage vocabulary and labels, ports `fao56Et0` vectors, gives its `WaterDay` the fields above, and decides the authority rule for gateway zones (edge writes, cloud mirrors) before any sync of `zone_daily_agronomy`.

## Error handling

- No station, no provider hours, or a partial day: the row exists with `et0_mm` null, `null_reason` set, `hours_present` and `expected_hours` filled; `etc_mm` null. Never a scaled or borrowed value.
- A station that stops: hours stop; the day is `partial_day`; the provider tier takes over for that day if complete.
- Wrong clock: a run more than 24 hours behind the newest stored hour is skipped; rows dated today or later are deleted on the next valid run. Source completeness never suppresses a row: a day with no hours from any source is written as `no_source`.
- A bad zone timezone: normalised to UTC with a warning once per run, listed in `tzFallback`.
- A zone with no coordinates: rows with `null_reason = 'no_location'`, never a guessed latitude.
- A run failure for one zone does not stop the others; the node warns on change only.

## Testing and acceptance

- `osi-crop-kc`: every vector in `kc-vectors.json`; legacy key mapping; unknown crop → heuristic; null stage → mid with `fao56_crop_stage_unset`.
- ET0 math: every vector in `et0-vectors.json` against the JavaScript port (values produced by the cloud's Java today); daily FAO-56 with and without elevation; Hargreaves; the lux conversion.
- `osi-station-hours`: hour aggregation from S2120 rows (means, min/max, sums, counts), a UTC-hour boundary, an hour with no sample, idempotence.
- `osi-agronomy-daily`: `localDayWindow` for 2026-03-29 (23 h) and 2026-10-25 (25 h) in Europe/Zurich and a day in Africa/Kampala; the all-hours rule; each tier and the precedence; `mixed_station`; `pending` vs `partial_day`; frozen Kc across a stage change; conditional upsert (second run writes 0 rows, `computed_at` unchanged); the clock bounds; gap days older than 7 days; in-flight guard; a scratch `node:sqlite` DB seeded from `seed-blank.sql` with provider and station fixtures; a facade-contract test.
- `osi-zone-env`: `buildWaterDaily` (null rain, demand fields, today forecast), `mergeDailyIrrigationSplit` with `todayIso` and a stale bundle; `buildAgronomic` picks the forecast day dated today and returns null ET0 from a stale cache, with an offline-across-midnight case (cached forecast from yesterday, clock past midnight → `etcMmDay` null, `evapotranspirationSource` `unavailable`).
- `osi-agronomy-daily` clock cases: a clock 24 h behind the store skips the run; a clock that ran ahead leaves rows dated today or later, which the next valid run deletes; an outage with no hours at all still writes `no_source` rows for every day in range; a MeteoSwiss day with a null `station_id` hour outside the refetch window is `unknown_station`.
- Station completeness: 24 rows with radiation in one hour only → tier 1 rejected, tier 3 accepted when temperature is complete; wind at 2 m and the same wind expressed at 10 m give the same ET0.
- Golden vectors: five cases green under `capture-zone-env-vectors.js --verify`.
- GUI (`npm run test:unit`, `npm run typecheck`, no build): the ported 14 + 13 cases; per-day ticks from `day.demandMm`; today dashed and labelled; null day dash; tooltip lines; legend keys in all seven locales; crop selector lists the catalogue grouped; stage selector labels per crop group; legacy stage loads mapped.
- Contract verifier `scripts/verify-agronomy-contract.js` green; all flows and schema gates green; the new nodes' size recorded in the ratchet.
- Acceptance on a linked test gateway (MeteoSwiss default) and the demo gateway (S2120 assigned, internet): after two ticks, seven rows per zone; on the demo gateway the station tier is chosen for zones with the station and its daily radiation sum is within 15 % (median over 7 days) of Open-Meteo's `shortwave_radiation` sum for the same location, else `LUX_PER_WM2` is corrected in the contract and re-verified; the Water tab shows seven distinct ticks with today dashed, and every explanation is reachable only through a tooltip.

## Scope boundaries

Not in this sub-project: any data-view change, any cloud change, syncing `zone_daily_agronomy` or `weather_station_hours`, a zone-level provider selector (sub-project 3), a stage history table, an ET0 for stations other than the S2120 (the hour aggregator is written so a second station type is one mapping), and any GUI caption or note.
