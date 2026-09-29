# Weather Provider Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An OSI OS gateway with internet stores one row per farm location and completed UTC hour of provider weather (temperature, humidity, rain, wind, radiation, ET0) in its own SQLite tables, from Open-Meteo or MeteoSwiss, chosen per deployment and overridable per zone.

**Architecture:** One additive ordered migration adds `weather_locations`, `weather_provider_hours`, `zone_daily_agronomy` and `irrigation_zones.weather_source`. One new helper package `osi-weather-provider` holds every line of logic (provider adapters, window computation, the tick) and is unit-tested against recorded fixtures and a scratch `node:sqlite` database. One thin Node-RED function node (under 1,500 characters) fed by a 30-minute inject binds the helper to the live database and the process environment. A UCI key sets the deployment default provider.

**Tech Stack:** Node.js 22 (`node:test`, `node:sqlite` for tests, `TextDecoder('windows-1252')`), SQLite via the `osi-db-helper` facade at runtime, Node-RED function nodes loaded through `osi-lib`, OpenWrt UCI + procd env.

**Spec:** `docs/superpowers/specs/2026-09-25-weather-provider-store-design.md`

## Global Constraints

- Work in the worktree `.worktrees/weather-provider-store` on branch `feat/weather-provider-store` (base: main `c5bc18314`). Never `cd` to the main checkout.
- Schema changes only through `database/migrations/ordered/0060__weather_provider_store.sql` with a `-- risk: additive` first line; `sync-init-fn` is frozen; no DDL in `flows.json` or `deploy.sh`.
- Every measurement column is nullable; a value the provider did not deliver is `NULL`, never `0`.
- `flows.json` is edited only by a one-shot Node script with the byte-identical roundtrip guard, and the bcm2709 copy is written from the same script.
- Every file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` that changes is copied byte-for-byte to `conf/full_raspberrypi_bcm27xx_bcm2709/files/`.
- The new function node stays under the 4,096-character ceiling and loads the helper only through `osiLib.require('weather-provider')`.
- Providers: `open_meteo` and `meteoswiss` only. The store keeps hours strictly before the current UTC hour. MeteoSwiss ET0 comes from the hourly `erefaoh0` column (FAO reference evaporation, mm), stored as delivered, including small negative night values.
- The spec's Open-Meteo request: `hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,shortwave_radiation,et0_fao_evapotranspiration`, `timezone=UTC`, `forecast_days=1`, `past_days` 2 normally and 92 on a location's first fetch. Wind arrives in km/h and is stored in m/s.
- MeteoSwiss: only the `ogd-smn` network (`https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/`), station within 15 km, at most 3 candidates by distance, a candidate must have a daily rain value (`rka150d0`) within the last 14 days, hourly files `*_h_now.csv` (today's UTC day) and `*_h_recent.csv` (1 January to yesterday 23:00), timestamps are UTC and mark the END of the hour. A station whose newest published hour is more than 3 h behind the clock is silent: keep its rows, record it in `last_error`, clear the station so the next tick resolves again.
- Every commit runs from the worktree root; commit messages use the repo's `type(scope): summary` style.

## Review Focus

1. **Open-Meteo `null` array entries.** A past hour whose value is `null` in the payload must be stored as `NULL`, not `0` and not skipped as a whole row. Pinned in Task 4.
2. **A zone with only one coordinate.** Latitude set, longitude null must fall back to the gateway location, not fetch at `(46.8, null)`. Pinned in Task 6.
3. **Two providers at one place.** Two zones at the same coordinates, one `open_meteo` and one `meteoswiss`, are two locations, two fetches, two row sets. Pinned in Task 6.
4. **MeteoSwiss outside Switzerland.** A `meteoswiss` zone at (48.9, 2.3) records `last_error` and no rows, and does not stop the other locations in the same tick. Pinned in Task 6.
5. **The in-progress hour.** At 15:20 UTC, an Open-Meteo payload that contains the stamp 16:00 (the hour 15:00 to 16:00, still running) must not produce a row; the newest stored `hour_start` is 14:00 (stamp 15:00). Pinned in Task 4 and Task 6.
6. **Outage gaps.** A gateway offline from Saturday to Tuesday must refill Saturday to Monday on the first tick back, for both providers, not only the last two days or today's file. Pinned in Task 4, Task 5 and Task 6.
7. **A silent station.** A MeteoSwiss station that stops publishing still answers HTTP 200 with old rows; the tick must record the silence and re-resolve the station next time instead of reporting success forever. Pinned in Task 6.

Hour convention, shared by both adapters: **`hour_start` T names the hour T to T+1h, and the row's values describe that hour.** MeteoSwiss stamps the END of the hour (a row stamped 16:00 holds 15:10 to 16:00), so `hour_start = stamp − 1h`. Open-Meteo's `precipitation`, `shortwave_radiation` and `et0_fao_evapotranspiration` at stamp T are the sums or means of the PRECEDING hour (T−1h to T), so the same shift applies; its `temperature_2m`, `relative_humidity_2m` and `wind_speed_10m` are the instantaneous values at T, i.e. at the end of the stored hour. Verified 2026-09-25 by the plan review: the Open-Meteo and MeteoSwiss radiation stamps for Payerne coincide (5 W/m² at stamp 18:00, after a 17:24 UTC sunset, is only possible for the hour 17:00 to 18:00).

---

### Task 1: Ordered migration and schema parity

**Files:**
- Create: `database/migrations/ordered/0060__weather_provider_store.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json`
- Modify: `database/seed-blank.sql` (append after the `zone_daily_environment` block, around line 944)
- Modify: `scripts/verify-db-schema-consistency.js` (`schemaContract`, and the `irrigation_zones` entry)
- Modify: the 7 bundled `farming.db` copies

**Interfaces:**
- Produces: tables `weather_locations(location_key PK, provider, latitude, longitude, timezone, station_id, station_name, station_distance_km, station_resolved_at, last_fetch_at, last_success_at, last_error, created_at)`, `weather_provider_hours(location_key, hour_start, air_temperature_c, relative_humidity_pct, rain_mm, wind_speed_mps, global_radiation_wm2, et0_mm, fetched_at; PK(location_key, hour_start))`, `zone_daily_agronomy(zone_id, date, et0_mm, et0_source, kc, kc_source, etc_mm, computed_at; PK(zone_id, date))`, column `irrigation_zones.weather_source TEXT NOT NULL DEFAULT 'auto'`.

- [ ] **Step 1: Confirm the next migration number**

Run: `ls database/migrations/ordered/ | tail -3`
Expected: `0058__gateway_eui_fallback.sql`, `0059__sync_rejection_recovery.sql`, `CHECKSUMS.json`. The new file is `0060`.

- [ ] **Step 2: Write the migration**

Create `database/migrations/ordered/0060__weather_provider_store.sql`:

```sql
-- risk: additive
-- 0060: Provider weather store (spec 2026-09-25-weather-provider-store-design):
-- hourly rows per farm location from Open-Meteo or MeteoSwiss, the daily
-- ET0/ETc record written by sub-project 2, and the per-zone provider override.
-- Every measurement column is nullable: an hour the provider did not deliver
-- stays NULL, never 0.

CREATE TABLE IF NOT EXISTS weather_locations (
  location_key        TEXT PRIMARY KEY,
  provider            TEXT NOT NULL CHECK (provider IN ('open_meteo', 'meteoswiss')),
  latitude            REAL NOT NULL,
  longitude           REAL NOT NULL,
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  station_id          TEXT,
  station_name        TEXT,
  station_distance_km REAL,
  station_resolved_at TEXT,
  last_fetch_at       TEXT,
  last_success_at     TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS weather_provider_hours (
  location_key          TEXT NOT NULL REFERENCES weather_locations(location_key) ON DELETE CASCADE,
  hour_start            TEXT NOT NULL,
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
  date        TEXT NOT NULL,
  et0_mm      REAL,
  et0_source  TEXT,
  kc          REAL,
  kc_source   TEXT,
  etc_mm      REAL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (zone_id, date)
);

ALTER TABLE irrigation_zones ADD COLUMN weather_source TEXT NOT NULL DEFAULT 'auto';
```

- [ ] **Step 3: Append the same DDL to `database/seed-blank.sql`**

Find the `irrigation_zones` CREATE TABLE (around line 60) and add `  weather_source              TEXT NOT NULL DEFAULT 'auto',` as the LAST column line, right after `  prediction_card_enabled     INTEGER DEFAULT 0,` (line 84) and immediately before `  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. The position matters: SQLite's `ADD COLUMN` appends after the last column, and `verify-seed-replay.js` fingerprints column order (`lib/osi-migrate/fingerprints.js`, `PRAGMA table_xinfo`), so a column placed after `phenological_stage` fails that gate (precedent: migration 0015's `zone_daily_environment.sync_version` sits last in the seed too). Then, after the `zone_daily_environment` block (ends at line 944 with `);`), insert the three `CREATE TABLE` statements verbatim from Step 2 (without the `ALTER TABLE` line), each preceded by the repo's banner comment style:

```sql
-- ---------------------------------------------------------------------------
-- weather_locations
-- ---------------------------------------------------------------------------
```

- [ ] **Step 4: Regenerate `CHECKSUMS.json`**

Run:
```bash
node -e "
const fs=require('fs'),crypto=require('crypto'),p='database/migrations/ordered/';
const m={};for(const f of fs.readdirSync(p).filter(f=>f.endsWith('.sql')).sort()){m[f]=crypto.createHash('sha256').update(fs.readFileSync(p+f)).digest('hex');}
fs.writeFileSync(p+'CHECKSUMS.json',JSON.stringify(m,null,2)+'\n');console.log(Object.keys(m).length,'entries');"
```
Expected: `60 entries`, and `git diff database/migrations/ordered/CHECKSUMS.json` shows exactly one added line for `0060__weather_provider_store.sql`.

- [ ] **Step 5: Rebuild the 7 bundled databases with the seed builder**

The bundled copies ship stamped at the migration head (a full `schema_migrations` ledger plus fingerprints, AGENTS.md "Never overwrite /data/db/farming.db" paragraph). Applying the SQL by hand with the `sqlite3` CLI leaves the ledger at 0059 and fails `verify-seed-db-ledger.js`; on a fresh gateway the runner would then re-run 0060 and stop on `duplicate column name: weather_source`. So:

Run: `node scripts/build-seed-db.js`
Expected: one line per path in `scripts/seed-db-paths.js` (all seven, including the bcm2709 mirror), no error. Then `sqlite3 database/farming.db "SELECT MAX(version) FROM schema_migrations"` prints `60`, and `sqlite3 database/farming.db "SELECT name FROM pragma_table_info('irrigation_zones') ORDER BY cid DESC LIMIT 1"` prints `weather_source`.

- [ ] **Step 6: Extend the hand-maintained schema contract**

In `scripts/verify-db-schema-consistency.js`, inside `schemaContract`, add three entries (place them right after the `zone_daily_environment` entry, around line 937):

```js
  weather_locations: ["location_key", "provider", "latitude", "longitude", "timezone", "station_id", "station_name", "station_distance_km", "station_resolved_at", "last_fetch_at", "last_success_at", "last_error", "created_at"],
  weather_provider_hours: ["location_key", "hour_start", "air_temperature_c", "relative_humidity_pct", "rain_mm", "wind_speed_mps", "global_radiation_wm2", "et0_mm", "fetched_at"],
  zone_daily_agronomy: ["zone_id", "date", "et0_mm", "et0_source", "kc", "kc_source", "etc_mm", "computed_at"],
```

`schemaContract` has no `irrigation_zones` entry today (checked 2026-09-25), and `compareSet` (lines ~1565-1574) rejects both missing and extra columns, so add the full entry rather than a partial one. After Step 5, take the exact list from the rebuilt seed and paste it:

```bash
sqlite3 database/farming.db "SELECT '\"' || group_concat(name, '\", \"') || '\"' FROM pragma_table_info('irrigation_zones')"
```

Expected (24 names, `weather_source` last):
```js
  irrigation_zones: ["id", "name", "user_id", "created_at", "updated_at", "deleted_at", "timezone", "zone_uuid", "gateway_device_eui", "sync_version", "area_m2", "irrigation_efficiency_pct", "scheduling_mode", "latitude", "longitude", "phenological_stage", "calibration_key", "crop_type", "variety", "soil_type", "irrigation_method", "notes", "prediction_card_enabled", "weather_source"],
```

- [ ] **Step 7: Run the schema gates**

Run:
```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-seed-db-ledger.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/test-journal-schema.js
```
Expected, in order: exit 0; `verify-seed-replay: OK`; `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)`; seven `OK` paths then `DB schema consistency verification passed`; the ledger gate exit 0 with every copy at head 60; exit 0; `All parity checks passed.`; `test-journal-schema: OK`. If `verify-seed-replay` reports a fingerprint difference, the seed and the migration disagree (a column order or a default); fix the seed to match the migration, never the other way round.

- [ ] **Step 8: Commit**

```bash
git add database/migrations/ordered/0060__weather_provider_store.sql database/migrations/ordered/CHECKSUMS.json database/seed-blank.sql scripts/verify-db-schema-consistency.js \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db database/farming.db web/react-gui/farming.db
git commit -m "feat(schema): weather provider store tables and zone weather_source (migration 0060)"
```

---

### Task 2: Helper package skeleton and registration

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/package.json`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.test.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/__fixtures__/{open_meteo_past2.json,pay_h_now.csv,pay_d_recent.csv,meta_stations_trimmed.csv}` (copied from `.superpowers/weather-fixtures/` in the worktree, captured live on 2026-09-25)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json` (dependencies)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json` (three entries)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js` (`NAME_TO_PATH`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js` (registry list + one assertion)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed` (module-copy loop, line 42)
- Modify: `deploy.sh` (two `fetch_required` blocks after the `osi-zone-env` ones, around line 1400)
- Modify: `.github/workflows/migrations.yml` (one `run:` line after the `osi-zone-env` test at line 96)
- Mirror: everything above under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is copied to `conf/full_raspberrypi_bcm27xx_bcm2709/files/`

**Interfaces:**
- Produces: `require('osi-weather-provider')` resolvable through `osiLib.require('weather-provider')`; exports are added in Tasks 3 to 6.

- [ ] **Step 1: Create the package with a smoke test**

`package.json`:
```json
{
  "name": "osi-weather-provider",
  "version": "1.0.0",
  "private": true,
  "main": "index.js"
}
```

`index.js`:
```js
'use strict';
// osi-weather-provider: provider weather (Open-Meteo, MeteoSwiss) stored per
// farm location and completed UTC hour. Spec:
// docs/superpowers/specs/2026-09-25-weather-provider-store-design.md
// Every function that touches the network takes its HTTP functions from a
// `deps` argument so the tests run on recorded fixtures.

const PROVIDERS = Object.freeze(['open_meteo', 'meteoswiss']);

module.exports = { PROVIDERS };
```

`index.test.js`:
```js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const wp = require('./index');

const FIXTURES = path.join(__dirname, '__fixtures__');
function fixture(name) { return fs.readFileSync(path.join(FIXTURES, name)); }

test('exports the two providers', () => {
  assert.deepEqual([...wp.PROVIDERS], ['open_meteo', 'meteoswiss']);
});
```

Copy the fixtures: `mkdir -p conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/__fixtures__ && cp .superpowers/weather-fixtures/* conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/__fixtures__/`

- [ ] **Step 2: Run the smoke test**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.test.js`
Expected: `# pass 1`.

- [ ] **Step 3: Register the module on all delivery surfaces**

1. `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`: add `"osi-weather-provider": "file:osi-weather-provider",` after the `"osi-zone-env"` line.
2. `package-lock.json` in the same directory: add, in the `packages` object, `"osi-weather-provider": "file:osi-weather-provider"` inside `packages[""].dependencies` (alphabetical position after `osi-valve-control`), a `"node_modules/osi-weather-provider": { "resolved": "osi-weather-provider", "link": true }` entry next to the other `node_modules/osi-*` links, and a `"osi-weather-provider": { "version": "1.0.0" }` entry next to the other bare package entries. Edit with a Node script that parses and re-serialises with `JSON.stringify(lock, null, 2) + '\n'` so the formatting stays identical to the file's own.
3. `osi-lib/index.js`: add `'weather-provider': 'osi-weather-provider',` to `NAME_TO_PATH` after the `'zone-env'` line.
4. `osi-lib/index.test.js`: the registered-names list is compared against `Object.keys(NAME_TO_PATH).sort()`, so it must stay sorted: insert `'weather-provider',` between `'uplink-dedup',` (line 52) and `'zone-commands',` (line 53). Add an assertion `assert.equal(osiLib.NAME_TO_PATH['weather-provider'], 'osi-weather-provider');` next to the `zone-env` one (line 60).
5. `98_osi_node_red_seed` line 42: append ` osi-weather-provider` to the `for module in ...` list (before `; do`).
6. `deploy.sh`: after the `osi-zone-env index.js` block (line 1400), add:
```bash
fetch_required "osi-weather-provider package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/package.json" \
    "/srv/node-red/osi-weather-provider/package.json"

fetch_required "osi-weather-provider index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.js" \
    "/srv/node-red/osi-weather-provider/index.js"
```
7. `.github/workflows/migrations.yml`: after line 96 add `      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.test.js`.

- [ ] **Step 4: Mirror to bcm2709**

Run:
```bash
rsync -a --delete conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/ conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider/
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package.json
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package-lock.json
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib/index.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib/index.test.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/98_osi_node_red_seed
```

- [ ] **Step 5: Run the registration and parity gates**

Run:
```bash
node scripts/verify-helper-registration.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node scripts/verify-profile-parity.js
```
Expected: `OK [...]` lines then `All helper-registration checks passed.`; osi-lib tests all pass; `All parity checks passed.`

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package-lock.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/98_osi_node_red_seed \
  deploy.sh .github/workflows/migrations.yml
git commit -m "feat(weather-provider): register the osi-weather-provider helper on every delivery surface"
```

---

### Task 3: Provider resolution, location key, hour arithmetic, fetch window

**Files:**
- Modify: `conf/.../osi-weather-provider/index.js`
- Test: `conf/.../osi-weather-provider/index.test.js`

**Interfaces:**
- Produces:
  - `resolveProvider(zoneWeatherSource: string|null, deploymentDefault: string|null): 'open_meteo'|'meteoswiss'|null` (`null` means "skip this zone")
  - `locationKey(provider, latitude, longitude): string` such as `open_meteo:46.80:6.95`
  - `hourStartIso(value: string|number|Date): string|null` floors to `YYYY-MM-DDTHH:00:00Z`
  - `addHours(hourStartIso, n): string`
  - `fetchWindow({ provider, newestStoredHour, nowIso }): { fromUtc, toUtc, firstFetch }`; `toUtc` is the current hour start (exclusive), `fromUtc` is `newestStoredHour - 3h`, or on a first fetch `now - 92 days` (Open-Meteo) / `1 January of the current UTC year` (MeteoSwiss).

- [ ] **Step 1: Write the failing tests**

Append to `index.test.js`:

```js
test('resolveProvider: zone override, deployment default, local skip, unknown values', () => {
  assert.equal(wp.resolveProvider('meteoswiss', 'open_meteo'), 'meteoswiss');
  assert.equal(wp.resolveProvider('auto', 'meteoswiss'), 'meteoswiss');
  assert.equal(wp.resolveProvider('auto', null), 'open_meteo');
  assert.equal(wp.resolveProvider(null, 'bogus'), 'open_meteo');
  assert.equal(wp.resolveProvider('openagri', 'meteoswiss'), 'meteoswiss');
  assert.equal(wp.resolveProvider('local', 'open_meteo'), null);
  assert.equal(wp.resolveProvider(' Open_Meteo ', 'meteoswiss'), 'open_meteo');
});

test('locationKey rounds to 2 decimals and shares a key across a farm', () => {
  assert.equal(wp.locationKey('open_meteo', 46.8004, 6.9499), 'open_meteo:46.80:6.95');
  assert.equal(wp.locationKey('open_meteo', 46.7996, 6.9501), 'open_meteo:46.80:6.95');
  assert.equal(wp.locationKey('meteoswiss', 46.8004, 6.9499), 'meteoswiss:46.80:6.95');
  assert.equal(wp.locationKey('open_meteo', -0.001, -0.004), 'open_meteo:0.00:0.00');
  assert.equal(wp.locationKey('open_meteo', -33.8688, 151.2093), 'open_meteo:-33.87:151.21');
});

test('hourStartIso floors to the hour in UTC and rejects garbage', () => {
  assert.equal(wp.hourStartIso('2026-09-25T15:20:33.123Z'), '2026-09-25T15:00:00Z');
  assert.equal(wp.hourStartIso('2026-09-25T15:00'), '2026-09-25T15:00:00Z'); // naive string = UTC, whatever TZ the process runs in
  assert.equal(wp.hourStartIso('2026-09-25T17:00:00+02:00'), '2026-09-25T15:00:00Z');
  assert.equal(wp.hourStartIso(Date.UTC(2026, 0, 1, 0, 59)), '2026-01-01T00:00:00Z');
  assert.equal(wp.hourStartIso('not a date'), null);
  assert.equal(wp.addHours('2026-09-25T15:00:00Z', -3), '2026-09-25T12:00:00Z');
  assert.equal(wp.addHours('2026-01-01T01:00:00Z', -2), '2025-12-31T23:00:00Z');
});

test('fetchWindow: normal tick re-reads three hours, first fetch backfills per provider', () => {
  const nowIso = '2026-09-25T15:20:00Z';
  assert.deepEqual(wp.fetchWindow({ provider: 'open_meteo', newestStoredHour: '2026-09-25T13:00:00Z', nowIso }), {
    fromUtc: '2026-09-25T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false,
  });
  assert.deepEqual(wp.fetchWindow({ provider: 'open_meteo', newestStoredHour: null, nowIso }), {
    fromUtc: '2026-06-25T15:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true,
  });
  assert.deepEqual(wp.fetchWindow({ provider: 'meteoswiss', newestStoredHour: null, nowIso }), {
    fromUtc: '2026-01-01T00:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true,
  });
  // A gap of several days: the window still starts 3 h before the newest row.
  assert.deepEqual(wp.fetchWindow({ provider: 'meteoswiss', newestStoredHour: '2026-09-20T09:00:00Z', nowIso }), {
    fromUtc: '2026-09-20T06:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false,
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.test.js`
Expected: 4 failing tests with `TypeError: wp.resolveProvider is not a function` and similar.

- [ ] **Step 3: Implement**

Add to `index.js` above `module.exports`, and export every name:

```js
const HOUR_MS = 3600000;
const REREAD_HOURS = 3;
const OPEN_METEO_BACKFILL_DAYS = 92;

function trimLower(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function resolveProvider(zoneWeatherSource, deploymentDefault) {
  const zone = trimLower(zoneWeatherSource);
  if (zone === 'local') return null;
  if (PROVIDERS.includes(zone)) return zone;
  const fallback = trimLower(deploymentDefault);
  return PROVIDERS.includes(fallback) ? fallback : 'open_meteo';
}

function fixed2(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  const text = (Object.is(rounded, -0) ? 0 : rounded).toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

function locationKey(provider, latitude, longitude) {
  return provider + ':' + fixed2(latitude) + ':' + fixed2(longitude);
}

// A date-time string without a zone suffix (Open-Meteo's `2026-09-25T10:00`)
// is UTC here; `new Date()` alone would read it in the process's local zone.
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function hourStartIso(value) {
  const input = typeof value === 'string' && NAIVE_ISO.test(value) ? value + 'Z' : value;
  const date = input instanceof Date ? input : new Date(input);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function addHours(iso, hours) {
  return hourStartIso(new Date(new Date(iso).getTime() + hours * HOUR_MS));
}

function fetchWindow({ provider, newestStoredHour, nowIso }) {
  const toUtc = hourStartIso(nowIso);
  if (!toUtc) throw new Error('fetchWindow: nowIso is not a date');
  const newest = newestStoredHour ? hourStartIso(newestStoredHour) : null;
  if (newest) {
    return { fromUtc: addHours(newest, -REREAD_HOURS), toUtc, firstFetch: false };
  }
  if (provider === 'meteoswiss') {
    const year = new Date(toUtc).getUTCFullYear();
    return { fromUtc: year + '-01-01T00:00:00Z', toUtc, firstFetch: true };
  }
  return { fromUtc: addHours(toUtc, -OPEN_METEO_BACKFILL_DAYS * 24), toUtc, firstFetch: true };
}
```

- [ ] **Step 4: Run to verify they pass**

Run the same command. Expected: `# pass 5`.

- [ ] **Step 5: Mirror and commit**

```bash
rsync -a --delete conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/ conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider/
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider
git commit -m "feat(weather-provider): provider resolution, location key and fetch window"
```

---

### Task 4: Open-Meteo adapter

**Files:**
- Modify: `conf/.../osi-weather-provider/index.js`
- Test: `conf/.../osi-weather-provider/index.test.js` (uses `__fixtures__/open_meteo_past2.json`, 72 hours from 2026-09-23T00:00 to 2026-09-25T23:00 UTC)

**Interfaces:**
- Consumes: `hourStartIso`, `fetchWindow` from Task 3.
- Produces:
  - `buildOpenMeteoUrl({ latitude, longitude }, pastDays): string`
  - `openMeteoPastDays(window): number` (92 on a first fetch; otherwise the days spanned by the window plus one, at least 2, at most 92)
  - `normalizeOpenMeteo(payload, fromUtc, toUtc): Row[]` where `Row = { hour_start, air_temperature_c, relative_humidity_pct, rain_mm, wind_speed_mps, global_radiation_wm2, et0_mm }`, `hour_start = stamp − 1h`, hours kept when `fromUtc <= hour_start < toUtc`, an hour whose six values are all null is dropped
  - `fetchOpenMeteoHours(location, window, deps): Promise<{ rows }>` with `deps.requestJson(url): Promise<object>`

- [ ] **Step 1: Write the failing tests**

```js
test('buildOpenMeteoUrl carries the six hourly variables, UTC and past_days', () => {
  const url = wp.buildOpenMeteoUrl({ latitude: 46.8, longitude: 6.95 }, 92);
  assert.match(url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.match(url, /latitude=46\.8&longitude=6\.95/);
  assert.match(url, /hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,shortwave_radiation,et0_fao_evapotranspiration/);
  assert.match(url, /&timezone=UTC/);
  assert.match(url, /&past_days=92/);
  assert.match(url, /&forecast_days=1/);
});

test('normalizeOpenMeteo maps the fixture, shifts stamps to hour_start, converts wind to m/s, cuts the window', () => {
  const payload = JSON.parse(fixture('open_meteo_past2.json').toString('utf8'));
  // The fixture runs from stamp 2026-09-23T00:00 to 2026-09-25T23:00. Stamp T
  // describes the hour T-1h..T, so the first stamp (hour 22:00-23:00 on the
  // 22nd) is before fromUtc and stamp 15:00 (hour 14:00-15:00) is the last kept.
  const rows = wp.normalizeOpenMeteo(payload, '2026-09-23T00:00:00Z', '2026-09-25T15:00:00Z');
  assert.equal(rows.length, 63);
  assert.equal(rows[0].hour_start, '2026-09-23T00:00:00Z');
  assert.equal(rows[rows.length - 1].hour_start, '2026-09-25T14:00:00Z');
  const first = rows[0]; // = payload index 1 (stamp 2026-09-23T01:00)
  assert.equal(payload.hourly.time[1], '2026-09-23T01:00');
  assert.equal(first.air_temperature_c, payload.hourly.temperature_2m[1]);
  assert.equal(first.relative_humidity_pct, payload.hourly.relative_humidity_2m[1]);
  assert.equal(first.rain_mm, payload.hourly.precipitation[1]);
  assert.equal(first.wind_speed_mps, Math.round(payload.hourly.wind_speed_10m[1] / 3.6 * 100) / 100);
  assert.equal(first.global_radiation_wm2, payload.hourly.shortwave_radiation[1]);
  assert.equal(first.et0_mm, payload.hourly.et0_fao_evapotranspiration[1]);
});

test('normalizeOpenMeteo stores a null array entry as null, keeps the row, drops an all-null hour', () => {
  const payload = {
    hourly: {
      time: ['2026-09-25T10:00', '2026-09-25T11:00', '2026-09-25T12:00'],
      temperature_2m: [12.5, null, null],
      relative_humidity_2m: [80, 81, null],
      precipitation: [null, 0, null],
      wind_speed_10m: [7.2, null, null],
      shortwave_radiation: [100, 120, null],
      et0_fao_evapotranspiration: [0.05, null, null],
    },
  };
  const rows = wp.normalizeOpenMeteo(payload, '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z');
  // Stamps 10:00 and 11:00 become hour_start 09:00 and 10:00; stamp 12:00 is
  // all null (Open-Meteo serves nulls for hours older than about 60 days in a
  // 92-day request) and is not a row at all.
  assert.deepEqual(rows.map((r) => r.hour_start), ['2026-09-25T09:00:00Z', '2026-09-25T10:00:00Z']);
  assert.equal(rows[0].rain_mm, null);
  assert.equal(rows[1].air_temperature_c, null);
  assert.equal(rows[1].wind_speed_mps, null);
  assert.equal(rows[1].et0_mm, null);
  assert.equal(rows[1].rain_mm, 0);
});

test('normalizeOpenMeteo returns no rows for a payload without hourly data', () => {
  assert.deepEqual(wp.normalizeOpenMeteo(null, '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z'), []);
  assert.deepEqual(wp.normalizeOpenMeteo({ hourly: { time: [] } }, '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z'), []);
});

test('openMeteoPastDays covers the window: 92 on a first fetch, 2 normally, more after an outage', () => {
  assert.equal(wp.openMeteoPastDays({ fromUtc: '2026-06-25T15:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true }), 92);
  assert.equal(wp.openMeteoPastDays({ fromUtc: '2026-09-25T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }), 2);
  assert.equal(wp.openMeteoPastDays({ fromUtc: '2026-09-20T06:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }), 7);
  assert.equal(wp.openMeteoPastDays({ fromUtc: '2026-01-01T00:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }), 92);
});

test('fetchOpenMeteoHours asks for 92 past days on a first fetch and 2 otherwise', async () => {
  const urls = [];
  const payload = JSON.parse(fixture('open_meteo_past2.json').toString('utf8'));
  const deps = { requestJson: async (url) => { urls.push(url); return payload; } };
  const location = { latitude: 46.8, longitude: 6.95 };
  await wp.fetchOpenMeteoHours(location, { fromUtc: '2026-06-25T15:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true }, deps);
  const result = await wp.fetchOpenMeteoHours(location, { fromUtc: '2026-09-25T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }, deps);
  assert.match(urls[0], /past_days=92/);
  assert.match(urls[1], /past_days=2/);
  // hour_start 10:00 .. 14:00 = stamps 11:00 .. 15:00
  assert.equal(result.rows.length, 5);
  assert.equal(result.rows[0].hour_start, '2026-09-25T10:00:00Z');
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: 5 new failures, `wp.buildOpenMeteoUrl is not a function` etc.

- [ ] **Step 3: Implement**

```js
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,shortwave_radiation,et0_fao_evapotranspiration';

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return value == null ? null : Math.round(value * 100) / 100;
}

function buildOpenMeteoUrl(location, pastDays) {
  return OPEN_METEO_BASE +
    '?latitude=' + encodeURIComponent(location.latitude) +
    '&longitude=' + encodeURIComponent(location.longitude) +
    '&hourly=' + OPEN_METEO_HOURLY +
    '&timezone=UTC' +
    '&past_days=' + Number(pastDays) +
    '&forecast_days=1';
}

function inWindow(hourStart, fromUtc, toUtc) {
  return !!hourStart && hourStart >= fromUtc && hourStart < toUtc;
}

const MEASUREMENT_KEYS = ['air_temperature_c', 'relative_humidity_pct', 'rain_mm', 'wind_speed_mps', 'global_radiation_wm2', 'et0_mm'];

function allNull(row) {
  return MEASUREMENT_KEYS.every((key) => row[key] == null);
}

// Open-Meteo stamp T: precipitation, radiation and ET0 are the preceding
// hour's sum/mean (T-1h..T); temperature, humidity and wind are instantaneous
// at T. Stored as hour_start = T-1h so both providers describe the same hour.
function normalizeOpenMeteo(payload, fromUtc, toUtc) {
  const hourly = payload && payload.hourly;
  const times = Array.isArray(hourly && hourly.time) ? hourly.time : [];
  const pick = (key, index) => toFiniteNumber(Array.isArray(hourly[key]) ? hourly[key][index] : null);
  const rows = [];
  for (let i = 0; i < times.length; i += 1) {
    const stamp = hourStartIso(times[i]);
    const hourStart = stamp ? addHours(stamp, -1) : null;
    if (!inWindow(hourStart, fromUtc, toUtc)) continue;
    const windKmh = pick('wind_speed_10m', i);
    const row = {
      hour_start: hourStart,
      air_temperature_c: pick('temperature_2m', i),
      relative_humidity_pct: pick('relative_humidity_2m', i),
      rain_mm: pick('precipitation', i),
      wind_speed_mps: windKmh == null ? null : round2(windKmh / 3.6),
      global_radiation_wm2: pick('shortwave_radiation', i),
      et0_mm: pick('et0_fao_evapotranspiration', i),
    };
    // An hour with no value at all is an absent hour (Open-Meteo returns
    // nulls for hours older than about 60 days), not a row of nulls.
    if (allNull(row)) continue;
    rows.push(row);
  }
  return rows;
}

// Enough past days to cover the window (so an outage gap is refilled), at
// least 2 and never more than the API's limit.
function openMeteoPastDays(window) {
  if (window.firstFetch) return OPEN_METEO_BACKFILL_DAYS;
  const spanMs = new Date(window.toUtc).getTime() - new Date(window.fromUtc).getTime();
  const days = Math.ceil(spanMs / (24 * HOUR_MS)) + 1;
  return Math.min(OPEN_METEO_BACKFILL_DAYS, Math.max(2, days));
}

async function fetchOpenMeteoHours(location, window, deps) {
  const payload = await deps.requestJson(buildOpenMeteoUrl(location, openMeteoPastDays(window)));
  return { rows: normalizeOpenMeteo(payload, window.fromUtc, window.toUtc) };
}
```

Note: Open-Meteo hour strings with `timezone=UTC` look like `2026-09-25T10:00` (no zone suffix); `hourStartIso` (Task 3) treats such strings as UTC, so no append is needed here.

- [ ] **Step 4: Run to verify they pass**

Expected: `# pass 11`.

- [ ] **Step 5: Mirror and commit**

```bash
rsync -a --delete conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/ conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider/
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider
git commit -m "feat(weather-provider): Open-Meteo hourly adapter"
```

---

### Task 5: MeteoSwiss adapter

**Files:**
- Modify: `conf/.../osi-weather-provider/index.js`
- Test: `conf/.../osi-weather-provider/index.test.js` (uses `__fixtures__/pay_h_now.csv` [21 rows, 2026-09-25 00:00 to 20:00 UTC end-of-hour], `__fixtures__/pay_d_recent.csv` [header + last 20 days, ending 24.09.2026], `__fixtures__/meta_stations_trimmed.csv` [PAY, GRA, MAH, NEU, CHD, SAM, LUG])

**Interfaces:**
- Consumes: `hourStartIso`, `addHours`, `toFiniteNumber`, `inWindow` from Tasks 3 and 4.
- Produces:
  - `decodeCsv(buffer): string` (Windows-1252), `splitCsvLine(line): string[]`, `parseCsv(text): string[][]`
  - `withinSwissCoverage(lat, lon): boolean` (45.5 to 48.0 N, 5.8 to 10.6 E)
  - `haversineKm(lat1, lon1, lat2, lon2): number`
  - `parseStations(text): { id, name, latitude, longitude }[]`
  - `nearestStations(stations, lat, lon, { maxKm = 15, limit = 3 }): (station & { distanceKm })[]`
  - `parseDailyRain(text): Map<'YYYY-MM-DD', number>` (column `rka150d0`), `measuresRain(daily, todayIso, days = 14): boolean`
  - `normalizeMeteoSwiss(text, fromUtc, toUtc): Row[]` (columns `tre200h0`, `ure200h0`, `rre150h0`, `fkl010h0`, `gre000h0`, `erefaoh0` = hourly FAO reference evaporation in mm; a missing column yields `null` for that field; `reference_timestamp` is the END of the hour, in UTC, `dd.MM.yyyy HH:mm`, so `hour_start = stamp − 1h`)
  - `mergeRows(...rowLists): Row[]` (later lists win on the same `hour_start`, result sorted)
  - `meteoSwissUrl(kind, stationId?)` for `'stations'`, `'d_recent'`, `'h_now'`, `'h_recent'`
  - `resolveMeteoSwissStation(location, nowIso, deps): Promise<{ id, name, latitude, longitude, distanceKm }>` (throws `outside MeteoSwiss coverage` / `no MeteoSwiss station with rain data within 15 km`)
  - `fetchMeteoSwissHours(location, window, deps, nowIso): Promise<{ rows, station }>` with `deps.requestBuffer(url): Promise<Buffer>`; uses the cached `location.station_id` when present, else resolves; reads `h_now` (today's UTC day) and, whenever `fromUtc` is before today 00:00 UTC (first fetch or an outage across midnight), also `h_recent` (1 January to yesterday 23:00), merged with `h_now` winning

- [ ] **Step 1: Write the failing tests**

```js
test('decodeCsv/splitCsvLine handle Windows-1252 and quoted separators', () => {
  assert.equal(wp.decodeCsv(Buffer.from([0x50, 0x41, 0x59, 0x3b, 0xe9])), 'PAY;é');
  assert.deepEqual(wp.splitCsvLine('a;"b;c";;d'), ['a', 'b;c', '', 'd']);
  assert.deepEqual(wp.parseCsv('﻿h1;h2\n1;2\n\n'), [['h1', 'h2'], ['1', '2']]);
});

test('withinSwissCoverage and haversineKm', () => {
  assert.equal(wp.withinSwissCoverage(46.8, 6.95), true);
  assert.equal(wp.withinSwissCoverage(48.9, 2.3), false);
  assert.equal(wp.withinSwissCoverage(NaN, 6.95), false);
  assert.equal(Math.round(wp.haversineKm(46.811581, 6.942469, 46.7714, 7.113736) * 10) / 10, 13.8);
});

test('parseStations + nearestStations pick Payerne first for a farm near Payerne', () => {
  const stations = wp.parseStations(wp.decodeCsv(fixture('meta_stations_trimmed.csv')));
  assert.equal(stations.length, 7);
  const near = wp.nearestStations(stations, 46.8, 6.95, { maxKm: 15, limit: 3 });
  assert.deepEqual(near.map((s) => s.id), ['PAY', 'GRA']);
  assert.equal(near[0].distanceKm, 1.4);
  assert.equal(near[0].name, 'Payerne');
  assert.deepEqual(wp.nearestStations(stations, 47.5, 8.5, { maxKm: 15, limit: 3 }), []);
});

test('parseDailyRain reads rka150d0 by date and measuresRain needs a value in the last 14 days', () => {
  const daily = wp.parseDailyRain(wp.decodeCsv(fixture('pay_d_recent.csv')));
  assert.equal(daily.size, 20);
  assert.equal(daily.has('2026-09-24'), true);
  assert.equal(typeof daily.get('2026-09-24'), 'number');
  assert.equal(wp.measuresRain(daily, '2026-09-25'), true);
  assert.equal(wp.measuresRain(daily, '2026-10-20'), false);
  assert.equal(wp.measuresRain(new Map(), '2026-09-25'), false);
});

test('normalizeMeteoSwiss shifts end-of-hour stamps, maps six columns by name, nulls empties', () => {
  const rows = wp.normalizeMeteoSwiss(wp.decodeCsv(fixture('pay_h_now.csv')), '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z');
  // Rows stamped 01:00 .. 15:00 (end of hour) become hour_start 00:00 .. 14:00; the 00:00 row is 2026-09-24T23:00 and falls before fromUtc.
  assert.equal(rows[0].hour_start, '2026-09-25T00:00:00Z');
  assert.equal(rows[rows.length - 1].hour_start, '2026-09-25T14:00:00Z');
  assert.equal(rows.length, 15);
  // The row stamped 25.09.2026 01:00 in the fixture, by header name (NOT by
  // position: fkl010h1 = 0.7 sits two columns before fkl010h0 = 0.2):
  // tre200h0=10.7 ure200h0=87.8 rre150h0=0 fkl010h0=0.2 gre000h0=0 erefaoh0=-0.024
  assert.deepEqual(rows[0], {
    hour_start: '2026-09-25T00:00:00Z',
    air_temperature_c: 10.7,
    relative_humidity_pct: 87.8,
    rain_mm: 0,
    wind_speed_mps: 0.2,
    global_radiation_wm2: 0,
    et0_mm: -0.024, // MeteoSwiss reports a small negative reference evaporation at night (dew); stored as delivered
  });
  const withEmpty = wp.normalizeMeteoSwiss('station_abbr;reference_timestamp;tre200h0;ure200h0;rre150h0;fkl010h0;gre000h0;erefaoh0\nPAY;25.09.2026 03:00;;55;;1.1;;\n', '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z');
  assert.deepEqual(withEmpty, [{ hour_start: '2026-09-25T02:00:00Z', air_temperature_c: null, relative_humidity_pct: 55, rain_mm: null, wind_speed_mps: 1.1, global_radiation_wm2: null, et0_mm: null }]);
  // A file without the ET0 column still yields rows, with et0_mm null.
  const noEt0 = wp.normalizeMeteoSwiss('station_abbr;reference_timestamp;tre200h0;ure200h0;rre150h0;fkl010h0;gre000h0\nPAY;25.09.2026 03:00;9;55;0;1.1;0\n', '2026-09-25T00:00:00Z', '2026-09-25T15:00:00Z');
  assert.equal(noEt0.length, 1);
  assert.equal(noEt0[0].et0_mm, null);
  assert.equal(noEt0[0].air_temperature_c, 9);
});

test('mergeRows: later lists win on the same hour and the result is sorted', () => {
  const merged = wp.mergeRows(
    [{ hour_start: '2026-09-24T22:00:00Z', rain_mm: 1 }, { hour_start: '2026-09-24T23:00:00Z', rain_mm: 2 }],
    [{ hour_start: '2026-09-24T23:00:00Z', rain_mm: 3 }, { hour_start: '2026-09-25T00:00:00Z', rain_mm: 4 }],
  );
  assert.deepEqual(merged.map((r) => [r.hour_start, r.rain_mm]), [['2026-09-24T22:00:00Z', 1], ['2026-09-24T23:00:00Z', 3], ['2026-09-25T00:00:00Z', 4]]);
});

test('meteoSwissUrl builds the documented file names', () => {
  assert.equal(wp.meteoSwissUrl('stations'), 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv');
  assert.equal(wp.meteoSwissUrl('h_now', 'PAY'), 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/pay/ogd-smn_pay_h_now.csv');
  assert.equal(wp.meteoSwissUrl('d_recent', 'GRA'), 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/gra/ogd-smn_gra_d_recent.csv');
});

function meteoSwissDeps(log) {
  return {
    requestBuffer: async (url) => {
      log.push(url);
      if (url.endsWith('_meta_stations.csv')) return fixture('meta_stations_trimmed.csv');
      if (url.endsWith('_d_recent.csv')) return fixture('pay_d_recent.csv');
      if (url.endsWith('_h_now.csv') || url.endsWith('_h_recent.csv')) return fixture('pay_h_now.csv');
      throw new Error('unexpected url ' + url);
    },
  };
}

test('resolveMeteoSwissStation picks the nearest station with rain evidence', async () => {
  const log = [];
  const station = await wp.resolveMeteoSwissStation({ latitude: 46.8, longitude: 6.95 }, '2026-09-25T15:20:00Z', meteoSwissDeps(log));
  assert.equal(station.id, 'PAY');
  assert.equal(station.distanceKm, 1.4);
  await assert.rejects(
    wp.resolveMeteoSwissStation({ latitude: 48.9, longitude: 2.3 }, '2026-09-25T15:20:00Z', meteoSwissDeps([])),
    /outside MeteoSwiss coverage/,
  );
  await assert.rejects(
    wp.resolveMeteoSwissStation({ latitude: 47.5, longitude: 8.5 }, '2026-09-25T15:20:00Z', meteoSwissDeps([])),
    /no MeteoSwiss station with rain data within 15 km/,
  );
});

test('fetchMeteoSwissHours reuses a cached station, reads h_now for today and adds h_recent when the window reaches back past midnight', async () => {
  const log = [];
  const deps = meteoSwissDeps(log);
  const cached = { latitude: 46.8, longitude: 6.95, station_id: 'PAY', station_name: 'Payerne', station_distance_km: 1.4 };
  const normal = await wp.fetchMeteoSwissHours(cached, { fromUtc: '2026-09-25T10:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }, deps);
  assert.deepEqual(log, ['https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/pay/ogd-smn_pay_h_now.csv']);
  assert.equal(normal.rows.length, 5);
  assert.equal(normal.station.id, 'PAY');
  log.length = 0;
  // An outage across midnight: the window starts on the 20th, so yesterday and earlier come from h_recent.
  const gap = await wp.fetchMeteoSwissHours(cached, { fromUtc: '2026-09-20T06:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: false }, deps);
  assert.deepEqual(log.map((u) => u.split('_').pop()), ['recent.csv', 'now.csv']);
  assert.equal(gap.rows.length, 16); // the fixture stands in for both files; merged on hour_start, so no duplicates
  log.length = 0;
  const first = await wp.fetchMeteoSwissHours({ latitude: 46.8, longitude: 6.95 }, { fromUtc: '2026-01-01T00:00:00Z', toUtc: '2026-09-25T15:00:00Z', firstFetch: true }, deps, '2026-09-25T15:20:00Z');
  assert.equal(log.some((u) => u.endsWith('_meta_stations.csv')), true);
  assert.equal(log.some((u) => u.endsWith('ogd-smn_pay_h_recent.csv')), true);
  assert.equal(log[log.length - 1], 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/pay/ogd-smn_pay_h_now.csv');
  // From 1 January the fixture's 00:00 row (hour_start 2026-09-24T23:00) is inside the window too: 16 rows.
  assert.equal(first.rows.length, 16);
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: 9 new failures.

- [ ] **Step 3: Implement**

```js
const METEOSWISS_BASE = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/';
const METEOSWISS_MAX_KM = 15;
const METEOSWISS_MAX_CANDIDATES = 3;
const METEOSWISS_RAIN_EVIDENCE_DAYS = 14;
const CSV_DECODER = new TextDecoder('windows-1252');

function decodeCsv(buffer) {
  return CSV_DECODER.decode(buffer);
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ';' && !quoted) { cells.push(current); current = ''; }
    else current += ch;
  }
  cells.push(current);
  return cells;
}

function parseCsv(text) {
  return String(text || '').replace(/^﻿/, '').split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map(splitCsvLine);
}

function optionalColumnIndex(header, name) {
  return header.findIndex((cell) => cell.trim().toLowerCase() === name);
}

function columnIndex(header, name) {
  const index = optionalColumnIndex(header, name);
  if (index < 0) throw new Error('MeteoSwiss column ' + name + ' missing');
  return index;
}

// A missing column (index -1) or an empty cell is null, never 0.
function cellNumber(row, index) {
  return toFiniteNumber(index >= 0 && index < row.length ? row[index].trim() : null);
}

function withinSwissCoverage(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= 45.5 && latitude <= 48.0 && longitude >= 5.8 && longitude <= 10.6;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  // Same radius as the cloud's MeteoSwissStationRainService.haversineKm, so
  // both sides pick the same station for the same coordinates.
  return 6371.0 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseStations(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0];
  const id = columnIndex(header, 'station_abbr');
  const name = columnIndex(header, 'station_name');
  const lat = columnIndex(header, 'station_coordinates_wgs84_lat');
  const lon = columnIndex(header, 'station_coordinates_wgs84_lon');
  const stations = [];
  for (const row of rows.slice(1)) {
    const latitude = cellNumber(row, lat);
    const longitude = cellNumber(row, lon);
    const stationId = (row[id] || '').trim();
    if (!stationId || latitude == null || longitude == null) continue;
    stations.push({ id: stationId, name: (row[name] || '').trim() || null, latitude, longitude });
  }
  return stations;
}

function nearestStations(stations, latitude, longitude, options) {
  const maxKm = options && options.maxKm != null ? options.maxKm : METEOSWISS_MAX_KM;
  const limit = options && options.limit != null ? options.limit : METEOSWISS_MAX_CANDIDATES;
  return stations
    .map((station) => ({ ...station, distanceKm: Math.round(haversineKm(latitude, longitude, station.latitude, station.longitude) * 10) / 10 }))
    .filter((station) => station.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

// 'dd.MM.yyyy HH:mm' in UTC -> ISO instant, or null.
function parseSwissTimestamp(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]))).toISOString();
}

function parseDailyRain(text) {
  const rows = parseCsv(text);
  const daily = new Map();
  if (!rows.length) return daily;
  const header = rows[0];
  const ts = columnIndex(header, 'reference_timestamp');
  const rain = columnIndex(header, 'rka150d0');
  for (const row of rows.slice(1)) {
    const start = parseSwissTimestamp(row[ts]);
    const value = cellNumber(row, rain);
    if (start && value != null) daily.set(start.slice(0, 10), round2(value));
  }
  return daily;
}

function measuresRain(daily, todayIso, days) {
  const horizon = days == null ? METEOSWISS_RAIN_EVIDENCE_DAYS : days;
  const oldest = new Date(new Date(todayIso.slice(0, 10) + 'T00:00:00Z').getTime() - horizon * 24 * HOUR_MS).toISOString().slice(0, 10);
  for (const date of daily.keys()) if (date >= oldest) return true;
  return false;
}

function normalizeMeteoSwiss(text, fromUtc, toUtc) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0];
  const ts = columnIndex(header, 'reference_timestamp');
  // Measurement columns are looked up by name; a station file lacking one
  // yields null for that field rather than failing the whole fetch.
  const col = {
    air_temperature_c: optionalColumnIndex(header, 'tre200h0'),   // air temperature 2 m, hourly mean, °C
    relative_humidity_pct: optionalColumnIndex(header, 'ure200h0'), // relative humidity 2 m, hourly mean, %
    rain_mm: optionalColumnIndex(header, 'rre150h0'),             // precipitation, hourly total, mm
    wind_speed_mps: optionalColumnIndex(header, 'fkl010h0'),      // wind speed scalar, hourly mean, m/s
    global_radiation_wm2: optionalColumnIndex(header, 'gre000h0'), // global radiation, hourly mean, W/m²
    et0_mm: optionalColumnIndex(header, 'erefaoh0'),              // FAO reference evaporation, hourly total, mm
  };
  const out = [];
  for (const row of rows.slice(1)) {
    const end = parseSwissTimestamp(row[ts]);
    if (!end) continue;
    const hourStart = addHours(hourStartIso(end), -1);
    if (!inWindow(hourStart, fromUtc, toUtc)) continue;
    out.push({
      hour_start: hourStart,
      air_temperature_c: cellNumber(row, col.air_temperature_c),
      relative_humidity_pct: cellNumber(row, col.relative_humidity_pct),
      rain_mm: cellNumber(row, col.rain_mm),
      wind_speed_mps: cellNumber(row, col.wind_speed_mps),
      global_radiation_wm2: cellNumber(row, col.global_radiation_wm2),
      et0_mm: cellNumber(row, col.et0_mm),
    });
  }
  return out;
}

function mergeRows(...lists) {
  const byHour = new Map();
  for (const list of lists) for (const row of list || []) byHour.set(row.hour_start, row);
  return [...byHour.values()].sort((a, b) => (a.hour_start < b.hour_start ? -1 : a.hour_start > b.hour_start ? 1 : 0));
}

function meteoSwissUrl(kind, stationId) {
  if (kind === 'stations') return METEOSWISS_BASE + 'ogd-smn_meta_stations.csv';
  const id = String(stationId).toLowerCase();
  return METEOSWISS_BASE + id + '/ogd-smn_' + id + '_' + kind + '.csv';
}

async function resolveMeteoSwissStation(location, nowIso, deps) {
  if (!withinSwissCoverage(location.latitude, location.longitude)) {
    throw new Error('outside MeteoSwiss coverage');
  }
  const stations = parseStations(decodeCsv(await deps.requestBuffer(meteoSwissUrl('stations'))));
  for (const candidate of nearestStations(stations, location.latitude, location.longitude)) {
    const daily = parseDailyRain(decodeCsv(await deps.requestBuffer(meteoSwissUrl('d_recent', candidate.id))));
    if (measuresRain(daily, nowIso)) return candidate;
  }
  throw new Error('no MeteoSwiss station with rain data within ' + METEOSWISS_MAX_KM + ' km');
}

async function fetchMeteoSwissHours(location, window, deps, nowIso) {
  const station = location.station_id
    ? { id: location.station_id, name: location.station_name || null, distanceKm: location.station_distance_km == null ? null : location.station_distance_km }
    : await resolveMeteoSwissStation(location, nowIso || window.toUtc, deps);
  // h_now holds only the current UTC day; anything earlier (a first fetch, or
  // an outage that crossed midnight) is in h_recent (1 January .. yesterday).
  const todayStart = window.toUtc.slice(0, 10) + 'T00:00:00Z';
  const lists = [];
  if (window.fromUtc < todayStart) {
    lists.push(normalizeMeteoSwiss(decodeCsv(await deps.requestBuffer(meteoSwissUrl('h_recent', station.id))), window.fromUtc, window.toUtc));
  }
  lists.push(normalizeMeteoSwiss(decodeCsv(await deps.requestBuffer(meteoSwissUrl('h_now', station.id))), window.fromUtc, window.toUtc));
  return { rows: mergeRows(...lists), station };
}
```

- [ ] **Step 4: Run to verify they pass**

Expected: `# pass 20`. The haversine radius is 6371.0, the cloud's value in `MeteoSwissStationRainService.haversineKm` (not `WeatherMath`); PAY is 1.4 km from (46.8, 6.95), GRA 12.9 km, PAY→GRA 13.8 km.

- [ ] **Step 5: Mirror and commit**

```bash
rsync -a --delete conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/ conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider/
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider
git commit -m "feat(weather-provider): MeteoSwiss station adapter"
```

---

### Task 6: The tick against a scratch database

**Files:**
- Modify: `conf/.../osi-weather-provider/index.js`
- Test: `conf/.../osi-weather-provider/index.test.js` (scratch DB from `database/seed-blank.sql`, which after Task 1 contains the new tables)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `fetchHours(provider, location, window, deps, nowIso): Promise<{ rows, station? }>` dispatching on provider
  - `httpDeps({ http, https, timeoutMs = 15000 }): { requestJson, requestBuffer }` built on Node's `http`/`https` request API (the same shape `zone-env-fn` uses)
  - `runTick({ db, nowIso, deploymentDefault, deps, warn }): Promise<{ zones, locations, stored, failed }>` where `db = { all(sql, params): Promise<rows>, run(sql, params): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

```js
const { DatabaseSync } = require('node:sqlite');
const REPO = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8');

function scratchDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  return {
    raw,
    all: async (sql, params) => raw.prepare(sql).all(...(params || [])),
    run: async (sql, params) => { raw.prepare(sql).run(...(params || [])); },
  };
}

function seedZone(db, { id, name, lat, lon, weatherSource, gatewayEui }) {
  // users: username, password_hash and created_at are NOT NULL (seed-blank.sql line 20-42).
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-25T00:00:00Z') ON CONFLICT DO NOTHING").run();
  // irrigation_zones: name and user_id are NOT NULL; zone_uuid is nullable but unique, so give each zone one.
  db.raw.prepare('INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, weather_source, gateway_device_eui, zone_uuid) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, lat, lon, 'Europe/Zurich', weatherSource || 'auto', gatewayEui || null, '00000000-0000-4000-8000-' + String(id).padStart(12, '0'));
}

function openMeteoOnlyDeps(log) {
  const payload = JSON.parse(fixture('open_meteo_past2.json').toString('utf8'));
  return {
    requestJson: async (url) => { log.push(url); return payload; },
    requestBuffer: async (url) => { throw new Error('offline: ' + url); },
  };
}

test('runTick stores completed hours for one location shared by two zones, and records success', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8004, lon: 6.9499 });
  seedZone(db, { id: 2, name: 'B', lat: 46.7996, lon: 6.9501 });
  const log = [];
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps(log), warn: () => {} });
  assert.deepEqual(summary, { zones: 2, locations: 1, stored: 63, failed: 0 });
  assert.equal(log.length, 1);
  assert.match(log[0], /past_days=92/);
  const loc = db.raw.prepare('SELECT * FROM weather_locations').all();
  assert.equal(loc.length, 1);
  assert.equal(loc[0].location_key, 'open_meteo:46.80:6.95');
  assert.equal(loc[0].timezone, 'Europe/Zurich');
  assert.equal(loc[0].last_error, null);
  assert.equal(loc[0].last_success_at, '2026-09-25T15:20:00Z');
  const newest = db.raw.prepare('SELECT MAX(hour_start) AS h FROM weather_provider_hours').get().h;
  assert.equal(newest, '2026-09-25T14:00:00Z');
});

test('runTick on a second tick asks for 2 past days and overwrites the last three hours', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  const log = [];
  const deps = openMeteoOnlyDeps(log);
  await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps, warn: () => {} });
  db.raw.prepare("UPDATE weather_provider_hours SET air_temperature_c = -99 WHERE hour_start = '2026-09-25T12:00:00Z'").run();
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:50:00Z', deploymentDefault: 'open_meteo', deps, warn: () => {} });
  assert.match(log[1], /past_days=2/);
  // newest stored hour is 14:00; the window re-reads 11:00, 12:00, 13:00 and 14:00.
  assert.equal(summary.stored, 4);
  const fixed = db.raw.prepare("SELECT air_temperature_c FROM weather_provider_hours WHERE hour_start = '2026-09-25T12:00:00Z'").get();
  assert.notEqual(fixed.air_temperature_c, -99);
});

test('runTick records the error and stores nothing when the provider is unreachable, then recovers', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'A', lat: 46.8, lon: 6.95 });
  const warnings = [];
  const failing = { requestJson: async () => { throw new Error('getaddrinfo ENOTFOUND api.open-meteo.com'); }, requestBuffer: async () => { throw new Error('offline'); } };
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: failing, warn: (m) => warnings.push(m) });
  assert.deepEqual(summary, { zones: 1, locations: 1, stored: 0, failed: 1 });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM weather_provider_hours').get().n, 0);
  const loc = db.raw.prepare('SELECT last_fetch_at, last_success_at, last_error FROM weather_locations').get();
  assert.equal(loc.last_fetch_at, '2026-09-25T15:20:00Z');
  assert.equal(loc.last_success_at, null);
  assert.match(loc.last_error, /ENOTFOUND/);
  assert.equal(warnings.length, 1);
  const ok = await wp.runTick({ db, nowIso: '2026-09-25T15:40:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn: () => {} });
  assert.equal(ok.failed, 0);
  assert.equal(db.raw.prepare('SELECT last_error FROM weather_locations').get().last_error, null);
});

test('runTick skips zones without coordinates or with weather_source=local, and falls back to the gateway location', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'no coords', lat: null, lon: null });
  seedZone(db, { id: 2, name: 'half coords', lat: 46.8, lon: null, gatewayEui: 'AABBCCDDEEFF0011' });
  seedZone(db, { id: 3, name: 'local', lat: 46.8, lon: 6.95, weatherSource: 'local' });
  // gateway_locations.updated_at is NOT NULL (seed-blank.sql line 2058-2075).
  db.raw.prepare("INSERT INTO gateway_locations (gateway_device_eui, latitude, longitude, updated_at) VALUES ('AABBCCDDEEFF0011', 46.2, 7.4, '2026-09-25T00:00:00Z')").run();
  const log = [];
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps(log), warn: () => {} });
  assert.equal(summary.locations, 1);
  assert.equal(db.raw.prepare('SELECT location_key FROM weather_locations').get().location_key, 'open_meteo:46.20:7.40');
});

test('runTick keeps two providers at one place as two locations and isolates a failing one', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'om', lat: 48.9, lon: 2.3, weatherSource: 'open_meteo' });
  seedZone(db, { id: 2, name: 'ms', lat: 48.9, lon: 2.3, weatherSource: 'meteoswiss' });
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn: () => {} });
  assert.deepEqual(summary, { zones: 2, locations: 2, stored: 63, failed: 1 });
  const rows = db.raw.prepare('SELECT location_key, provider, last_error FROM weather_locations ORDER BY location_key').all();
  assert.deepEqual(rows.map((r) => r.provider), ['meteoswiss', 'open_meteo']);
  assert.match(rows[0].last_error, /outside MeteoSwiss coverage/);
  assert.equal(rows[1].last_error, null);
});

test('runTick with MeteoSwiss stores the station on the location and reads h_now next time', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  const log = [];
  const deps = { requestJson: async () => { throw new Error('should not call Open-Meteo'); }, ...meteoSwissDeps(log) };
  const first = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.equal(first.failed, 0);
  // node:sqlite rows have a null prototype; spread them before a deep-equal.
  const loc = { ...db.raw.prepare('SELECT station_id, station_name, station_distance_km, station_resolved_at FROM weather_locations').get() };
  assert.deepEqual(loc, { station_id: 'PAY', station_name: 'Payerne', station_distance_km: 1.4, station_resolved_at: '2026-09-25T15:20:00Z' });
  assert.equal(log[log.length - 1], wp.meteoSwissUrl('h_now', 'PAY'));
  log.length = 0;
  await wp.runTick({ db, nowIso: '2026-09-25T15:50:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.deepEqual(log, [wp.meteoSwissUrl('h_now', 'PAY')]);
  // The fixture row stamped 11:00 (hour_start 10:00) carries erefaoh0 as delivered.
  assert.equal(typeof db.raw.prepare("SELECT et0_mm FROM weather_provider_hours WHERE hour_start = '2026-09-25T10:00:00Z'").get().et0_mm, 'number');
});

test('runTick re-resolves a MeteoSwiss station after 24 hours', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  const log = [];
  const deps = { requestJson: async () => { throw new Error('should not call Open-Meteo'); }, ...meteoSwissDeps(log) };
  // The fixture is dated 2026-09-25, so both ticks run on that day (an earlier
  // day would make the station look silent); the age of the resolution is
  // simulated by moving station_resolved_at back 25 hours.
  await wp.runTick({ db, nowIso: '2026-09-25T10:20:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.equal(db.raw.prepare('SELECT station_resolved_at FROM weather_locations').get().station_resolved_at, '2026-09-25T10:20:00Z');
  db.raw.prepare("UPDATE weather_locations SET station_resolved_at = '2026-09-24T09:20:00Z'").run();
  log.length = 0;
  await wp.runTick({ db, nowIso: '2026-09-25T10:50:00Z', deploymentDefault: 'meteoswiss', deps, warn: () => {} });
  assert.equal(log.some((u) => u.endsWith('_meta_stations.csv')), true, 'station list re-read after a day');
  assert.equal(db.raw.prepare('SELECT station_resolved_at FROM weather_locations').get().station_resolved_at, '2026-09-25T10:50:00Z');
});

test('runTick flags a silent MeteoSwiss station and forgets it so the next tick re-resolves', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, name: 'ms', lat: 46.8, lon: 6.95 });
  const log = [];
  const deps = { requestJson: async () => { throw new Error('should not call Open-Meteo'); }, ...meteoSwissDeps(log) };
  const warnings = [];
  // The fixture's newest stamp is 25.09.2026 20:00 (hour_start 19:00). At 23:50 the newest completed hour is 22:00, more than 3 h later.
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T23:50:00Z', deploymentDefault: 'meteoswiss', deps, warn: (m) => warnings.push(m) });
  assert.equal(summary.failed, 0);
  // The rows it did publish are kept: 21 fixture rows, hour_start 2026-09-24T23:00 .. 2026-09-25T19:00, all inside the 1 January window.
  assert.equal(summary.stored, 21);
  const loc = { ...db.raw.prepare('SELECT station_id, last_error, last_success_at FROM weather_locations').get() };
  assert.equal(loc.station_id, null);
  assert.match(loc.last_error, /station PAY silent since 2026-09-25T19:00:00Z/);
  assert.equal(loc.last_success_at, '2026-09-25T23:50:00Z');
  assert.equal(warnings.length, 1);
});

test('runTick reports a missing table once and stores nothing', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE irrigation_zones (id INTEGER PRIMARY KEY, latitude REAL, longitude REAL, timezone TEXT, weather_source TEXT, gateway_device_eui TEXT, deleted_at TEXT)');
  const db = { all: async (sql, p) => raw.prepare(sql).all(...(p || [])), run: async (sql, p) => { raw.prepare(sql).run(...(p || [])); } };
  const warnings = [];
  const summary = await wp.runTick({ db, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: openMeteoOnlyDeps([]), warn: (m) => warnings.push(m) });
  assert.deepEqual(summary, { zones: 0, locations: 0, stored: 0, failed: 0, error: 'weather tables missing (deploy the schema migration)' });
  assert.equal(warnings.length, 1);
});
```

Note on `seedZone`: the NOT NULL columns of `users`, `irrigation_zones` and `gateway_locations` were checked against `database/seed-blank.sql` on 2026-09-25 and are all supplied above. If an INSERT still fails with a NOT NULL error, the seed changed; add that one column with a literal and say so in the commit message. Keep the helper in the test file.

- [ ] **Step 2: Run to verify they fail**

Expected: 9 new failures.

- [ ] **Step 3: Implement**

```js
function httpDeps({ http, https, timeoutMs }) {
  const timeout = Math.max(1000, Number(timeoutMs || 15000) || 15000);
  function request(urlString) {
    return new Promise((resolve, reject) => {
      const lib = urlString.startsWith('https:') ? https : http;
      const req = lib.request(urlString, { method: 'GET', headers: { 'User-Agent': 'osi-os weather-provider' } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const status = Number(res.statusCode || 0);
          const body = Buffer.concat(chunks);
          if (status < 200 || status >= 300) return reject(new Error('HTTP ' + status + ' from ' + urlString));
          resolve(body);
        });
      });
      req.on('error', reject);
      req.setTimeout(timeout, () => req.destroy(new Error('timeout after ' + timeout + ' ms: ' + urlString)));
      req.end();
    });
  }
  return {
    requestBuffer: request,
    requestJson: async (url) => JSON.parse((await request(url)).toString('utf8')),
  };
}

function fetchHours(provider, location, window, deps, nowIso) {
  if (provider === 'meteoswiss') return fetchMeteoSwissHours(location, window, deps, nowIso);
  return fetchOpenMeteoHours(location, window, deps);
}

const ZONE_SQL =
  'SELECT iz.id, iz.latitude, iz.longitude, iz.timezone, iz.weather_source, ' +
  'gl.latitude AS gateway_latitude, gl.longitude AS gateway_longitude ' +
  'FROM irrigation_zones iz ' +
  'LEFT JOIN gateway_locations gl ON gl.gateway_device_eui = iz.gateway_device_eui ' +
  'WHERE iz.deleted_at IS NULL';

const UPSERT_LOCATION_SQL =
  'INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone) VALUES (?, ?, ?, ?, ?) ' +
  'ON CONFLICT(location_key) DO UPDATE SET timezone = excluded.timezone';

const UPSERT_HOUR_SQL =
  'INSERT INTO weather_provider_hours (location_key, hour_start, air_temperature_c, relative_humidity_pct, rain_mm, wind_speed_mps, global_radiation_wm2, et0_mm, fetched_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(location_key, hour_start) DO UPDATE SET ' +
  'air_temperature_c = excluded.air_temperature_c, relative_humidity_pct = excluded.relative_humidity_pct, rain_mm = excluded.rain_mm, ' +
  'wind_speed_mps = excluded.wind_speed_mps, global_radiation_wm2 = excluded.global_radiation_wm2, et0_mm = excluded.et0_mm, fetched_at = excluded.fetched_at';

const METEOSWISS_SILENT_AFTER_HOURS = 3;

function zoneCoordinates(zone) {
  const lat = toFiniteNumber(zone.latitude);
  const lon = toFiniteNumber(zone.longitude);
  if (lat != null && lon != null) return { latitude: lat, longitude: lon };
  const glat = toFiniteNumber(zone.gateway_latitude);
  const glon = toFiniteNumber(zone.gateway_longitude);
  if (glat != null && glon != null) return { latitude: glat, longitude: glon };
  return null;
}

async function tablesPresent(db) {
  const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('weather_locations', 'weather_provider_hours')", []);
  return rows.length === 2;
}

async function runTick({ db, nowIso, deploymentDefault, deps, warn }) {
  const say = typeof warn === 'function' ? warn : () => {};
  const summary = { zones: 0, locations: 0, stored: 0, failed: 0 };
  if (!(await tablesPresent(db))) {
    summary.error = 'weather tables missing (deploy the schema migration)';
    say(summary.error);
    return summary;
  }
  const zones = await db.all(ZONE_SQL, []);
  const locations = new Map();
  for (const zone of zones) {
    const provider = resolveProvider(zone.weather_source, deploymentDefault);
    const coords = provider ? zoneCoordinates(zone) : null;
    if (!coords) continue;
    summary.zones += 1;
    const key = locationKey(provider, coords.latitude, coords.longitude);
    if (!locations.has(key)) {
      locations.set(key, { key, provider, latitude: coords.latitude, longitude: coords.longitude, timezone: String(zone.timezone || 'UTC').trim() || 'UTC' });
    }
  }
  for (const location of locations.values()) {
    summary.locations += 1;
    await db.run(UPSERT_LOCATION_SQL, [location.key, location.provider, location.latitude, location.longitude, location.timezone]);
    const stored = (await db.all('SELECT station_id, station_name, station_distance_km, station_resolved_at FROM weather_locations WHERE location_key = ?', [location.key]))[0] || {};
    const newest = (await db.all('SELECT MAX(hour_start) AS newest FROM weather_provider_hours WHERE location_key = ?', [location.key]))[0];
    const window = fetchWindow({ provider: location.provider, newestStoredHour: newest && newest.newest, nowIso });
    // A station is resolved once and re-resolved when that resolution is older
    // than a day (spec "Data model"), so a decommissioned station is replaced.
    const resolvedMs = stored.station_resolved_at ? Date.parse(stored.station_resolved_at) : NaN;
    const stationStale = !stored.station_id || !Number.isFinite(resolvedMs) || Date.parse(nowIso) - resolvedMs > 24 * HOUR_MS;
    const cachedStation = stationStale ? {} : stored;
    try {
      const result = await fetchHours(location.provider, { ...location, station_id: cachedStation.station_id || null, station_name: cachedStation.station_name || null, station_distance_km: cachedStation.station_distance_km }, window, deps, nowIso);
      let newestFetched = null;
      for (const row of result.rows) {
        if (row.hour_start >= window.toUtc) continue;
        await db.run(UPSERT_HOUR_SQL, [location.key, row.hour_start, row.air_temperature_c, row.relative_humidity_pct, row.rain_mm, row.wind_speed_mps, row.global_radiation_wm2, row.et0_mm, nowIso]);
        summary.stored += 1;
        if (!newestFetched || row.hour_start > newestFetched) newestFetched = row.hour_start;
      }
      const station = result.station || null;
      // A station that stopped publishing still answers HTTP 200 with old rows.
      // Its newest completed hour more than 3 h behind the clock is a silent
      // station: keep what it sent, say so, and forget it so the next tick
      // resolves a station again.
      const silentBefore = addHours(window.toUtc, -METEOSWISS_SILENT_AFTER_HOURS);
      const silent = location.provider === 'meteoswiss' && (!newestFetched || newestFetched < silentBefore);
      if (silent) {
        const message = 'station ' + (station ? station.id : '?') + ' silent since ' + (newestFetched || 'the start of the window');
        say(location.key + ': ' + message);
        await db.run(
          'UPDATE weather_locations SET last_fetch_at = ?, last_success_at = ?, last_error = ?, station_id = NULL, station_resolved_at = NULL WHERE location_key = ?',
          [nowIso, nowIso, message, location.key]
        );
      } else if (station && stationStale) {
        await db.run(
          'UPDATE weather_locations SET last_fetch_at = ?, last_success_at = ?, last_error = NULL, station_id = ?, station_name = ?, station_distance_km = ?, station_resolved_at = ? WHERE location_key = ?',
          [nowIso, nowIso, station.id, station.name || null, station.distanceKm == null ? null : station.distanceKm, nowIso, location.key]
        );
      } else {
        await db.run('UPDATE weather_locations SET last_fetch_at = ?, last_success_at = ?, last_error = NULL WHERE location_key = ?', [nowIso, nowIso, location.key]);
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error).slice(0, 500);
      summary.failed += 1;
      say(location.key + ': ' + message);
      await db.run('UPDATE weather_locations SET last_fetch_at = ?, last_error = ? WHERE location_key = ?', [nowIso, message, location.key]);
    }
  }
  return summary;
}
```

Add every new name to `module.exports`.

- [ ] **Step 4: Run to verify they pass**

Expected: `# pass 29`. Run also `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js` to be sure the loader still resolves the package (`# fail 0`). If the silent-station test's `stored` count disagrees, count the fixture: `pay_h_now.csv` has 21 data rows stamped 00:00 to 20:00; from 1 January every one is inside the window, so 21 rows are stored; correct the assertion to the counted value and say so in the commit.

- [ ] **Step 5: Prove the module through the real database facade**

`runTick` is called from a flow node with `osi-db-helper`'s facade (promise-returning `all`/`run`, no `.prepare`), but the tests above use a `node:sqlite` wrapper. That is the PR-M failure class (`scripts/verify-osi-lib-db-caller-binding.js` header comment). Create `conf/.../osi-weather-provider/facade-contract.test.js`, modelled on `osi-device-writer/facade-contract.test.js`: copy that file's `sqlite3Adapter()` and `loadOsiDbHelper()` verbatim (they scope a `node:sqlite`-backed `sqlite3` shim to osi-db-helper's own `require('sqlite3')`), then:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wp = require('./index');
// ... sqlite3Adapter() and loadOsiDbHelper() copied from osi-device-writer/facade-contract.test.js ...
const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO_ROOT, 'database/seed-blank.sql'), 'utf8');

test('runTick works through the osi-db-helper facade exactly as weather-provider-fn binds it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-facade-'));
  const dbPath = path.join(dir, 'farming.db');
  const { DatabaseSync } = require('node:sqlite');
  const seed = new DatabaseSync(dbPath);
  seed.exec(SEED);
  seed.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-25T00:00:00Z')").run();
  seed.prepare("INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, zone_uuid) VALUES (1, 1, 'A', 46.8, 6.95, 'Europe/Zurich', '00000000-0000-4000-8000-000000000001')").run();
  seed.close();
  const osiDb = loadOsiDbHelper();
  const db = new osiDb.Database(dbPath);
  // The same three lines the flow node uses.
  const client = {
    all: (sql, params) => Promise.resolve(db.all(sql, params || [])),
    run: (sql, params) => Promise.resolve(db.run(sql, params || [])).then(() => undefined),
  };
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'open_meteo_past2.json'), 'utf8'));
  const summary = await wp.runTick({ db: client, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: { requestJson: async () => payload, requestBuffer: async () => { throw new Error('offline'); } }, warn: () => {} });
  await new Promise((resolve) => db.close(() => resolve()));
  assert.deepEqual(summary, { zones: 1, locations: 1, stored: 63, failed: 0 });
  const check = new DatabaseSync(dbPath);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM weather_provider_hours').get().n, 63);
  check.close();
});
```

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/facade-contract.test.js`
Expected: `# pass 1`. Then add this file to CI: in `.github/workflows/migrations.yml`, after the `osi-weather-provider/index.test.js` line added in Task 2, add `      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/facade-contract.test.js`.

- [ ] **Step 6: Mirror and commit**

```bash
rsync -a --delete conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/ conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider/
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-weather-provider .github/workflows/migrations.yml
git commit -m "feat(weather-provider): tick that stores completed hours per location, proven through the db facade"
```

---

### Task 7: Flow nodes (inject + thin function node)

**Files:**
- Modify (by script only): `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` and `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json` (`total_allowance`)
- Possibly: `scripts/verify-flows-size-ratchet-baseline.json` (only if the doc-baseline check asks for `--write-baseline`)
- Scratch: `$SCRATCHPAD/flows-add-weather-tick.js` (never committed)

**Interfaces:**
- Consumes: `osiLib.require('weather-provider')` → `{ runTick, httpDeps }` from Task 6.
- Produces: inject node `weather-provider-tick` (every 1800 s, once on start after 20 s) wired to function node `weather-provider-fn`, both on the same tab as `zone-env-fn` (`z: 'dendro-analytics-tab'`).

- [ ] **Step 1: Write the one-shot editor in the scratchpad**

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
function serialize(flows) { return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8'); }
function assertRoundtrip(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) throw new Error('roundtrip guard failed for ' + filePath);
  return parsed;
}
const flows = assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
if (flows.some((n) => n.id === 'weather-provider-fn' || n.id === 'weather-provider-tick')) throw new Error('nodes already present');
const anchor = flows.find((n) => n.id === 'zone-env-fn');
if (!anchor) throw new Error('zone-env-fn not found');

const FUNC = [
  "return (async () => {",
  "  const load = osiLib.require('weather-provider');",
  "  if (!load.ok) { node.error('weather provider tick: module unavailable: ' + load.error); return null; }",
  "  const db = new osiDb.Database('/data/db/farming.db');",
  "  const client = {",
  "    all: (sql, params) => Promise.resolve(db.all(sql, params || [])),",
  "    run: (sql, params) => Promise.resolve(db.run(sql, params || [])).then(() => undefined)",
  "  };",
  "  const close = () => new Promise((res) => db.close(() => res()));",
  "  try {",
  "    msg.payload = await load.value.runTick({",
  "      db: client,",
  "      nowIso: new Date().toISOString(),",
  "      deploymentDefault: env.get('OSI_WEATHER_PROVIDER_DEFAULT'),",
  "      deps: load.value.httpDeps({ http: httpLib, https: httpsLib }),",
  "      warn: (message) => node.warn('weather provider tick: ' + message)",
  "    });",
  "    return msg;",
  "  } catch (error) {",
  "    node.warn('weather provider tick failed: ' + (error && error.message ? error.message : error));",
  "    return null;",
  "  } finally {",
  "    await close();",
  "  }",
  "})();",
].join('\n');

flows.push({
  id: 'weather-provider-tick',
  type: 'inject',
  z: anchor.z,
  name: 'Weather provider tick (30m)',
  props: [{ p: 'payload' }],
  repeat: '1800',
  crontab: '',
  once: true,
  onceDelay: '20',
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 170,
  y: anchor.y + 600, // below the dendro reference-tree pair at y=420; cosmetic only
  wires: [['weather-provider-fn']],
}, {
  id: 'weather-provider-fn',
  type: 'function',
  z: anchor.z,
  name: 'Weather provider: store hours',
  func: FUNC,
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [
    { var: 'osiLib', module: 'osi-lib' },
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'httpLib', module: 'http' },
    { var: 'httpsLib', module: 'https' },
  ],
  x: 470,
  y: anchor.y + 600,
  wires: [[]],
});
fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
console.log('added 2 nodes; function chars =', FUNC.length);
```

Before running, compare the property set of the new function node with `zone-env-fn`'s (`node -e "const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');console.log(Object.keys(f.find(n=>n.id==='zone-env-fn')))"`) and add any key the repo's function nodes carry that the script omits (e.g. `timeout`, `noerr`, `initialize`, `finalize`), with the same default values.

- [ ] **Step 2: Run the editor from the worktree root**

Run: `node $SCRATCHPAD/flows-add-weather-tick.js`
Expected: `added 2 nodes; function chars = <n>` with n below 1500.

- [ ] **Step 3: Run the flows gate set**

```bash
node scripts/verify-profile-parity.js
node scripts/verify-flows-fn-parse.js
node scripts/flows-bare-require-scan.js
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-no-stray-ddl.js
bash scripts/check-mqtt-topics.sh
node scripts/verify-flows-size-ratchet.js
node scripts/verify-sync-flow.js
```
Expected: parity `All parity checks passed.`; `verify-flows-fn-parse: OK`; bare-require exit 0; wiring `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`; silent-catch exit 0; stray-DDL exit 0; three `OK:` lines; size ratchet: see Step 4; sync flow ends `All parity checks passed.`

- [ ] **Step 4: Record the size-ratchet provenance**

If `verify-flows-size-ratchet.js` fails on "total embedded JS increased", or passes only because of unearned headroom in `total_allowance`, re-measure and record it. Measure with:

```bash
node -e "
const {totalChars}=require('./scripts/flows-size-scan');
const {execFileSync}=require('child_process');
const head=JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8'));
const base=JSON.parse(execFileSync('git',['show','origin/main:conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'],{maxBuffer:64*1024*1024}).toString());
console.log('base',totalChars(base),'head',totalChars(head),'delta',totalChars(head)-totalChars(base));"
```

Then edit `scripts/verify-flows-size-ratchet-allowances.json`: set `total_allowance.delta` to the measured delta (the new node's characters, exact) and replace the reason with one sentence naming this feature, the two node ids, the measured base and head totals, and the date. The committed doc baseline (`scripts/verify-flows-size-ratchet-baseline.json`) is already below origin/main's own total (checked 2026-09-25: HEAD 1,580,418 per profile against a committed 1,571,684), so the doc-baseline check fails as soon as the allowance shrinks: run `node scripts/verify-flows-size-ratchet.js --write-baseline` unconditionally, then `node scripts/verify-flows-size-ratchet.js` must exit 0, and commit the regenerated baseline with the allowance.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json
git commit -m "feat(flows): weather provider tick stores provider hours every 30 minutes"
```

---

### Task 8: Deployment default via UCI and the init script

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config` (inside the `uci -q batch` block, after the `openagri_weather_forecast_cache_minutes` line 37)
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config`
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` (read near line 302, export near line 452)
- Modify: `.claude/skills/osi-config-and-flags/SKILL.md` (section 1 table, one row)
- Modify: `AGENTS.md` (one paragraph right after the "**Journal V2 media cache:**" paragraph, line 203; AGENTS.md has no weather configuration lines today)
- Not modified: `scripts/verify-communication-contract.js` has no list of weather exports (checked 2026-09-25), so it needs no entry.

**Interfaces:**
- Produces: process env `OSI_WEATHER_PROVIDER_DEFAULT` = UCI `osi-server.cloud.weather_provider_default`, default `open_meteo`.

- [ ] **Step 1: Add the UCI default**

After line 37 of `96_osi_server_config` add:
```
set osi-server.cloud.weather_provider_default=open_meteo
```

- [ ] **Step 2: Read and export it in `node-red.init`**

After line 302 add:
```sh
    local weather_provider_default=$(uci -q get osi-server.cloud.weather_provider_default 2>/dev/null || echo "open_meteo")
    case "$weather_provider_default" in open_meteo|meteoswiss) ;; *) weather_provider_default="open_meteo" ;; esac
```
After the `OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES=...` line in the `procd_set_param env` block add:
```sh
        OSI_WEATHER_PROVIDER_DEFAULT="$weather_provider_default" \
```

- [ ] **Step 3: Mirror, document, verify**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config
sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init && echo "init parses"
node scripts/verify-communication-contract.js
node scripts/verify-profile-parity.js
```

Add to the config skill's section 1 table:
```
| `weather_provider_default` | Observation weather provider for zones whose `weather_source` is `auto`: `open_meteo` or `meteoswiss` (customer branches for Swiss farms set `meteoswiss`); the forecast always comes from Open-Meteo | `open_meteo` | `node-red.init` validates and exports as `OSI_WEATHER_PROVIDER_DEFAULT`; read by flows.json node `weather-provider-fn` |
```
and one paragraph to `AGENTS.md` after the Journal V2 media cache paragraph (line 203), starting with `**Provider weather store:**`: "Provider weather (temperature, humidity, rain, wind, radiation, ET0) is stored per farm location and completed UTC hour in `weather_locations` / `weather_provider_hours` by the `weather-provider-fn` tick (30 min); the provider is UCI `osi-server.cloud.weather_provider_default` (`open_meteo` | `meteoswiss`) unless a zone's `weather_source` overrides it; nothing syncs (each side fetches for itself)."

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init .claude/skills/osi-config-and-flags/SKILL.md AGENTS.md
git commit -m "feat(config): weather_provider_default UCI key exported as OSI_WEATHER_PROVIDER_DEFAULT"
```

---

### Task 9: Whole-branch gate run and execution report

**Files:**
- Create: `docs/superpowers/plans/2026-09-25-weather-provider-store-execution-report.md`

- [ ] **Step 1: Run every gate touched by this branch, fresh**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/facade-contract.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-seed-db-ledger.js
node scripts/verify-sqlite-cli-limits.js
node scripts/verify-no-stray-ddl.js
node scripts/test-journal-schema.js
node scripts/verify-helper-registration.js
node scripts/verify-module-file-deploy-coverage.js
node scripts/verify-osi-lib-db-caller-binding.js
node scripts/verify-profile-parity.js
node scripts/verify-flows-fn-parse.js
node scripts/flows-bare-require-scan.js
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
bash scripts/check-mqtt-topics.sh
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
node --test lib/osi-migrate/__tests__/*.test.js
```

- [ ] **Step 2: Live probe of both providers from the workstation (read-only, no gateway)**

```bash
node -e "
const wp=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider');
const deps=wp.httpDeps({http:require('http'),https:require('https')});
const now=new Date().toISOString();
(async()=>{
  const om=await wp.fetchOpenMeteoHours({latitude:46.8,longitude:6.95},wp.fetchWindow({provider:'open_meteo',newestStoredHour:null,nowIso:now}),deps);
  console.log('open_meteo rows',om.rows.length,'first',om.rows[0].hour_start,'last',om.rows[om.rows.length-1].hour_start);
  const ms=await wp.fetchMeteoSwissHours({latitude:46.8,longitude:6.95},wp.fetchWindow({provider:'meteoswiss',newestStoredHour:null,nowIso:now}),deps,now);
  console.log('meteoswiss station',ms.station.id,ms.station.distanceKm,'rows',ms.rows.length,'last',ms.rows[ms.rows.length-1].hour_start);
})().catch(e=>{console.error(e);process.exit(1);});"
```
Expected: about 1,450 Open-Meteo rows (the 92-day request returns roughly 60 days of real values; older hours are all-null and dropped) ending at the previous UTC hour; station `PAY` at 1.4 km with several thousand rows ending at the last complete hour MeteoSwiss has published.

- [ ] **Step 3: Write the execution report**

Sections: what was built (one paragraph), the exact gate outputs from Step 1 (pass lines, verbatim), the live probe output, the size-ratchet numbers, what was left out (GUI, zone selector, agronomy writer, cloud), and the acceptance step that still needs a test gateway (spec "Testing and acceptance", last paragraph). Run `node .claude/skills/anti-slop-writing/slop-check.js` on it.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-09-25-weather-provider-store-execution-report.md
git commit -m "docs(weather-provider): execution report for sub-project 1"
```
