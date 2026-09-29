# Weather provider store design

**Status:** Proposed for implementation (sub-project 1 of 4)

**Decision:** Store hourly weather from an online provider per farm location on the edge, in dedicated tables, whenever the gateway has internet. The provider is a per-deployment default (Open-Meteo on main, MeteoSwiss on customer branches) that a zone can override. Nothing syncs to the cloud; the cloud fetches for itself. The forecast keeps its current live path and provider.

## Intent

Phil wants provider weather (temperature, humidity, rain, reference evapotranspiration) recorded automatically and available in the data view next to local sensors, so a soil-tension curve can be read against the rain and heat that shaped it. The same store must carry the daily reference evapotranspiration (ET0) from which crop demand (ETc) is derived, so the Water tab's "Last 7 days" plot can show each day's real demand instead of repeating today's value.

This sub-project delivers the store and the fetch job only. Later sub-projects consume it:

| Sub-project | Delivers |
|---|---|
| 1 (this spec) | Edge tables, fetch job, provider adapters, deployment default, zone override column |
| 2 | Daily ET0 and ETc record per zone; Water tab 7-day demand; the pending edge port of the cloud's "Last 7 days" chart (brief W53) |
| 3 | Data view exposure: a `weather:<provider>` history source, the `et0_mm` channel, the `environment-variables` overlay, CSV export, and the zone settings selector for the provider |
| 4 | Cloud counterparts in osi-server, including MeteoSwiss temperature, humidity and its published hourly ET0 |

Success for sub-project 1 means:

- a gateway with internet accumulates one row per location and hour, with the provider named on every row;
- a gateway without internet stores nothing and keeps retrying without log spam;
- a missing hour or value is absent or null, never zero;
- a customer branch changes the default provider by editing one uci-defaults line;
- the schema gates in `osi-schema-change-control` all pass, and `sync-init-fn` is untouched.

## Current state

The edge computes ETc at read time only. `buildAgronomic()` in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js` multiplies the Open-Meteo forecast's day-0 ET0 by a stage-only crop coefficient. Nothing persists the result. `zone_weather_cache` holds one payload per zone and cache key and is overwritten on every refresh, so no history survives there.

The cloud is one step ahead: `OpenMeteoService.getDailyArchive` reads the archive API per day, and `MeteoSwissStationRainService` reads the nearest station's hourly and daily files, but only the two rain columns. Its chart (`waterChart.ts`, osi-server #207) draws today's ETc on every day of the week; #208 removed the note that said so.

Measured on 2026-09-25 against the live files for station PAY (Payerne), the MeteoSwiss hourly files (`*_h_now.csv`, `*_h_recent.csv`) carry `tre200h0` (air temperature, hourly mean, °C), `ure200h0` (relative humidity, hourly mean, %), `rre150h0` (precipitation, hourly total, mm), `fkl010h0` (wind speed, hourly mean, m/s), `gre000h0` (global radiation, hourly mean, W/m²) and `erefaoh0` (FAO reference evaporation, hourly total, mm; the daily file has `erefaod0`). All 158 `ogd-smn` station files share that header. Night values of `erefaoh0` are small negatives (dew) and are stored as delivered. `*_h_now.csv` holds the current UTC day only; `*_h_recent.csv` holds 1 January to yesterday 23:00. Stamps are UTC and mark the end of the hour.

Open-Meteo's forecast endpoint returns hourly `temperature_2m`, `relative_humidity_2m`, `precipitation`, `wind_speed_10m` (km/h), `shortwave_radiation` and `et0_fao_evapotranspiration`, and accepts `past_days` up to 92. Its precipitation, radiation and ET0 at stamp T are the preceding hour's sum or mean (T−1h to T), matching MeteoSwiss's end-of-hour convention; temperature, humidity and wind are instantaneous at T. Hours older than about 60 days come back null in every variable; those are absent hours, not rows. Past hours from this endpoint are model analysis, not measurements.

Hour convention for the store: `hour_start` T names the hour T to T+1h, so both providers' stamps are shifted back one hour on the way in.

## Data model

One additive ordered migration creates three tables and one column. Every measurement column is nullable; a value the provider did not deliver stays null.

```sql
-- risk: additive
CREATE TABLE IF NOT EXISTS weather_locations (
  location_key        TEXT PRIMARY KEY,   -- '<provider>:<lat2>:<lon2>', coordinates rounded to 2 decimals
  provider            TEXT NOT NULL CHECK (provider IN ('open_meteo', 'meteoswiss')),
  latitude            REAL NOT NULL,
  longitude           REAL NOT NULL,
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  station_id          TEXT,               -- MeteoSwiss station abbreviation, null for a grid provider
  station_name        TEXT,
  station_distance_km REAL,
  station_resolved_at TEXT,               -- when the station was last chosen; re-resolved after 24 h
  last_fetch_at       TEXT,
  last_success_at     TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS weather_provider_hours (
  location_key          TEXT NOT NULL REFERENCES weather_locations(location_key) ON DELETE CASCADE,
  hour_start            TEXT NOT NULL,    -- UTC, 'YYYY-MM-DDTHH:00:00Z'
  air_temperature_c     REAL,
  relative_humidity_pct REAL,
  rain_mm               REAL,
  wind_speed_mps        REAL,
  global_radiation_wm2  REAL,
  et0_mm                REAL,
  fetched_at            TEXT NOT NULL,
  PRIMARY KEY (location_key, hour_start)
);

CREATE TABLE IF NOT EXISTS zone_daily_agronomy (
  zone_id     INTEGER NOT NULL REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,              -- zone-local calendar day
  et0_mm      REAL,
  et0_source  TEXT,                       -- 'open_meteo', 'meteoswiss_fao56', ...
  kc          REAL,
  kc_source   TEXT,                       -- 'heuristic_phenology', 'fao56_crop'
  etc_mm      REAL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (zone_id, date)
);

ALTER TABLE irrigation_zones ADD COLUMN weather_source TEXT NOT NULL DEFAULT 'auto';
```

`zone_daily_agronomy` is created here and written in sub-project 2, so the schema lands once. It is deliberately not part of `zone_daily_environment`: that table's rows exist only on days a rain gauge or flow meter reported, and its rain column defaults to 0, so a nightly ETc writer creating rows there would turn every dry-gauge day into a fabricated 0 mm measurement.

`weather_source` takes the cloud's enum values (`auto`, `local`, `open_meteo`, `openagri`, `agromonitoring`, `meteoswiss`); the edge job acts on `auto`, `open_meteo` and `meteoswiss` and treats the rest as `auto`. No CHECK constraint, matching the cloud column.

The location key rounds coordinates to 2 decimals (about 1.1 km), so a farm's zones share one row and one fetch. MeteoSwiss station rows use the same key shape; the station is a property of the location, resolved once (`station_resolved_at`) and re-resolved when that is older than 24 hours or after the station fell silent. Resolving a station costs up to five requests (the station list, up to three daily files for the rain-evidence rule, then the hourly file); a normal tick costs one.

Retention is unbounded. One location produces 8,760 rows a year of nine small columns, well under a megabyte.

No outbox trigger, no sync contract entry, no boot-node edit. The cloud fetches the same providers for its own zones (sub-project 4).

## Provider adapters

A new helper package `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/` (mirrored to bcm2709, declared in the Node-RED `package.json` like the other `osi-*` packages) exports:

```js
resolveProvider(zoneWeatherSource, deploymentDefault)   // -> 'open_meteo' | 'meteoswiss' | null
locationKey(provider, latitude, longitude)             // -> 'open_meteo:46.80:6.95'
fetchWindow({ provider, newestStoredHour, nowIso })    // -> { fromUtc, toUtc, firstFetch }
fetchHours(provider, location, window, deps, nowIso)   // -> { rows: [...], station?: {...} }
normalizeOpenMeteo(payload, fromUtc, toUtc)            // pure
normalizeMeteoSwiss(csvText, fromUtc, toUtc)           // pure
runTick({ db, nowIso, deploymentDefault, deps, warn }) // the whole tick
```

`fetchHours` returns rows of the `weather_provider_hours` shape. The two adapters:

- **Open-Meteo** calls the forecast endpoint with `hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,shortwave_radiation,et0_fao_evapotranspiration`, `timezone=UTC`, `past_hours=N` and `forecast_hours=1`, and keeps only completed hours. That response ends at the provider's current hour whatever the gateway clock says, so a gateway clock running ahead cannot receive forecast hours (`past_days`/`forecast_days` would run to the end of the day). `N` is 2208 (92 days) on a location's first fetch; otherwise it is the number of hours the window spans plus 24, at least 48 and at most 2208, so an outage gap is refilled on the first tick back. Wind arrives in km/h and is converted to m/s. An hour whose six values are all null is not stored.
- **MeteoSwiss** resolves the nearest SwissMetNet station with the same distance (15 km, 3 candidates, Earth radius 6371.0) and rain-evidence rules the cloud's `MeteoSwissStationRainService` uses. A station that fell silent is tried last for 24 hours, and is still chosen when no other candidate has rain data. Station ids must be 2 to 8 letters or digits: the station list skips any other id, and none reaches a URL. The adapter always reads `*_h_now.csv`, which holds the current UTC day (its row stamped 00:00 is yesterday's last hour). It reads `*_h_recent.csv` (1 January to yesterday, about 1 MB and rebuilt once a day) only on a first fetch or when the window reaches an hour before today that `h_now` did not deliver; outside a first fetch, that read happens at most once per 2 hours per station. The two files are merged with today's file winning. Timestamps mark the end of the hour, so a row stamped 16:00 is stored as `hour_start` 15:00. Empty fields and missing columns become null, and a row whose six values are all empty is not stored. Only `ogd-smn` stations are used; `ogd-smn-precip` stations carry rain alone and would leave every other column null. This means the edge's rain station can differ from the cloud's, which also reads the precipitation network; the cloud side aligns in sub-project 4.

The HTTP layer is injected (`deps.requestJson`, `deps.requestBuffer`), so unit tests run against recorded fixtures without a network. Fixtures: one Open-Meteo response, one MeteoSwiss `h_now` file, the last 20 rows of its `d_recent` file, and a seven-station cut of the station metadata file, captured on 2026-09-25 and committed under the package's `__fixtures__/`.

## Fetch job

One new inject node, "Weather provider tick", every 30 minutes, wired to one new function node `weather-provider-fn`. The node:

1. Reads the deployment default from `env.get('OSI_WEATHER_PROVIDER_DEFAULT')`.
2. Loads active zones (`deleted_at IS NULL`) with their coordinates resolved as `resolveLocation()` in `osi-zone-env` does today (zone coordinates, else gateway location). Zones with no coordinates or `weather_source = 'local'` are skipped.
3. Groups zones by location key (zones read in id order) and upserts `weather_locations`. Requests use the key's rounded coordinates, so every zone of a key asks for the same grid point.
4. For each location, computes the fetch window up to the current hour, exclusive. It starts at the earlier of two hours: the newest stored `hour_start`, capped at the current hour, minus 3 hours (so a provider's late correction overwrites the earlier value, and rows stamped after the clock are re-read as real time reaches them); and the first hour missing from the store in the last 7 days, counted from no earlier than the location's first stored hour (so an hour that a provider file had not yet published when it was due is read again). On the first fetch the window is the adapter's backfill horizon instead (92 days for Open-Meteo, 1 January for MeteoSwiss). After an outage the window is as long as the outage, and both adapters fetch enough to fill it. A location whose newest stored hour is more than 24 hours after the clock is skipped: `last_error` says `clock behind the store: newest hour <hour> is after <now>` and nothing is written.
5. Calls `fetchHours` and upserts rows with `INSERT ... ON CONFLICT(location_key, hour_start) DO UPDATE`.
6. Records `last_fetch_at`, and either `last_success_at` with `last_error = NULL` or `last_error` with the message. A MeteoSwiss station whose newest published hour is more than 3 hours behind the clock is silent: its rows are stored, `last_error` says `station PAY silent since <hour>`, and `station_id` is cleared so the next tick resolves a station again. A `node.warn` is written only when a location's message differs from its stored `last_error` (timestamps masked, so a later hour of the same problem is not a new one), and once as `<key>: recovered` when the error clears.

A tick that starts while the previous one is still running returns `{ skipped: 'in_flight' }` at once, without touching the database. Locations are processed sequentially. A normal tick costs one HTTP request per location (the Open-Meteo call, or the MeteoSwiss `h_now` file). A MeteoSwiss location adds an `h_recent` read when a gap before today needs filling, throttled to once per 2 hours per station, and up to four more requests (the station list and up to three daily files) when its station is resolved or re-resolved. A location nobody references any more (all its zones deleted or re-pointed) is left in place; sub-project 3 decides whether the data view shows it.

MeteoSwiss's hourly file is rebuilt every 10 minutes and Open-Meteo's past hours change rarely, so 30 minutes is a compromise between freshness on the chart and load on two public services.

## Configuration

A UCI key `osi-server.cloud.weather_provider_default` with value `open_meteo`, added to `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config` (mirrored to bcm2709). `node-red.init` exports it as `OSI_WEATHER_PROVIDER_DEFAULT`. The line is guarded (`uci -q get ... || uci set ...`), so a re-run never resets an operator's value. Customer branches set the uci-defaults value to `meteoswiss`. Already-provisioned gateways do not re-run uci-defaults, so a customer gateway is switched with `uci set osi-server.cloud.weather_provider_default=meteoswiss && uci commit osi-server && /etc/init.d/node-red restart`. Switching creates a new location key, and the store backfills again under the new provider.

Resolution order for a zone: `irrigation_zones.weather_source` when it names a provider the edge implements, else the deployment default, else `open_meteo`. The zone setting has no GUI in this sub-project; sub-project 3 adds the selector.

The OpenAgri keys and the forecast cache TTL are untouched. The forecast stays on Open-Meteo for every deployment because MeteoSwiss serves no forecast.

## Error handling

- No internet, DNS failure, HTTP error, or malformed body: the adapter throws, the job writes `last_error` and stores nothing for that location, and moves to the next location. It logs a `node.warn` only when the location's message changes (timestamps masked), and once on recovery. The next tick retries from the same window.
- A partial response (some hours, some null fields) is stored as delivered. Null is the only representation of "not delivered".
- A MeteoSwiss station whose newest row is older than 3 hours is treated as silent, as the cloud does: its rows are stored as far as they go, `last_error` notes the staleness, and the station is forgotten so the next tick chooses again, trying that station last for 24 hours.
- The job never writes an hour later than the current UTC hour, so forecast hours cannot leak into the store.
- A location whose newest stored hour is more than 24 hours after the clock is skipped with `clock behind the store`: the gateway clock is wrong, and nothing is written until it is right again.
- A tick that starts while the previous one is still running returns `skipped: 'in_flight'` and touches nothing.
- If `weather_locations` or `weather_provider_hours` is missing (deploy skipped the migration), the job logs one error and returns; it does not create tables.

## Testing and acceptance

Unit tests under the package (`node --test`):

- `normalizeOpenMeteo` maps the fixture to rows, shifts stamps to `hour_start`, converts wind to m/s, keeps nulls, drops all-null hours and hours at or after `toUtc`;
- `normalizeMeteoSwiss` parses Windows-1252 CSV with `;` separators, shifts end-of-hour stamps to `hour_start`, maps empty fields and missing columns to null, reads columns by name;
- `locationKey` rounds and formats stably (46.8004, 6.9499 and 46.7996, 6.9501 share one key);
- `resolveProvider` honours zone override, deployment default, and the `local` skip;
- the window computation and the fetch that follows it: first fetch, normal tick, and a gap of several days (Open-Meteo asks for enough past hours; MeteoSwiss reads both files);
- the gap rule: a 6-hour hole two days back moves the window to the hole's first hour and fills it, while hours before the location's first stored hour do not count as a hole;
- `h_recent` gating: a tick after midnight without a gap reads only `h_now`; a gap reads `h_now`, then `h_recent`; a second gap read within 2 hours is skipped; a first fetch reads both regardless;
- clock guards: a newest hour in the future re-reads from the current hour minus 3 hours, one more than 24 hours ahead skips the location with `clock behind the store`, and a station resolution dated in the future counts as stale;
- repeated identical failures warn once and a recovery once, and a tick started while another runs returns `skipped: 'in_flight'` without touching the database;
- the silent-station exclusion: the next tick picks another station with rain data, and keeps the only station in range;
- `runTick` against a scratch `node:sqlite` database seeded from `seed-blank.sql`: stores rows, records errors without rows on failure, never stores a future hour, keeps two providers at one place apart, falls back to the gateway location, flags a silent station and re-resolves after 24 h.

A facade-contract test binds `runTick` through the real `osi-db-helper` facade exactly as the flow node does, the same guard `osi-device-writer` carries against the unawaited-facade failure class.

Schema gates, all required green: `verify-migrations.js`, `verify-seed-replay.js`, `verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js` (contract extended with the three tables and the zone column), `verify-seed-db-ledger.js` (the bundled seeds are rebuilt with `build-seed-db.js`, never patched by hand), `verify-no-stray-ddl.js`, `verify-profile-parity.js`, `verify-sync-flow.js`, plus the flows gates and `verify-helper-registration.js`.

Acceptance runs on a linked test gateway only, never a farm device, and only after `sqlite3 /data/db/farming.db "SELECT MAX(version) FROM schema_migrations"` prints `59`. A different gateway already carries the RAK branch's own `0060` and would refuse this migration with `repair_required: checksum mismatch`; do not use it for acceptance. After one tick with internet, `SELECT COUNT(*) FROM weather_provider_hours WHERE air_temperature_c IS NOT NULL` is at least 1,400 for an Open-Meteo location (about 60 days of real values in the 92-day request) and `last_error` is null; after pulling the uplink, the next tick sets `last_error` and the count is unchanged.

## Scope boundaries

Out of scope for this sub-project, owned by the later ones: writing `zone_daily_agronomy`, any GUI change, any history helper change, any cloud change, and the sync of provider rows (none is planned).

Known collision: main's highest ordered migration is `0059`, so this spec takes `0060`. The unmerged `feat/rak10701-coverage` branch also carries a `0060`; whichever merges second renumbers.
