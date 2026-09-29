# Weather in the data view design

**Status:** Proposed for implementation (sub-project 3 of 4; branch `feat/weather-data-view`, stacked on `feat/daily-agronomy` @ `8531f1dd1`; edge, plus the manifest and contract copies on a same-named osi-server branch). Revised after the review committee of 2026-09-27 and the plan review of the same day; the last section lists each finding and where the spec now answers it.

**Decision:** The analysis page (`/analysis`, the Data tab on desktop) reads three new source kinds besides `device_data`: the stored provider hours (`weather_provider_hours`), the local station hours (`weather_station_hours`) and the daily agronomy record (`zone_daily_agronomy`). Three channels join the manifest (`global_radiation_wm2`, `et0_mm`, `etc_mm`). Hourly totals are summed, not averaged, when a bucket spans several rows; daily buckets of the hourly weather kinds follow the zone's local days; a summed series names its period in its unit (`mm/h`, `mm/d`, `mm/wk`) and marks buckets with missing hours. Each zone gets a weather provider selector (`weather_source`: auto, open_meteo, meteoswiss, local) that the edge stores, emits to the cloud in every zone update event and in the bootstrap and force-sync snapshots, and accepts from the cloud on both command paths. The edge advertises the sync capability `zone_config_weather_source_v1` so the cloud can send the field only to gateways that accept it. After sub-project 4 the edge owns `weather_source` like every other zone config field, and this edge must not reach a cloud-linked gateway before that cloud change (see "Ownership and deploy order").

## Intent

Phil wants to read a soil-tension curve against the rain, heat and evaporative demand that shaped it, on the same chart, without a local station if the gateway has internet. The weather store (sub-project 1) and the daily record (sub-project 2) hold that data on the gateway; nothing reads the hourly rows yet, and the zone's provider setting has no GUI. He ruled on 2026-09-26 to keep all five items of the brief: data view sources, the three channels, CSV through the existing analysis export, the zone selector, and the `weather_source` round trip.

Success means:

- the Data tab lists, under each zone with a location, one provider source with six channels, one hourly source per assigned S2120, and one daily agronomy source with ET0 and ETc, and every tray button of these sources shows its channel name;
- a daily or weekly bucket of provider rain or ET0 equals the sum of the hours of that zone-local day or span, checked against SQL on a live gateway, and a bucket with missing hours says so in its tooltip;
- a day whose `et0_mm` is null breaks the line instead of drawing zero, and a single valid day between null days is visible;
- the analysis page's CSV contains the new series, with the zone-local date for daily points;
- a provider chosen in zone settings is stored, reaches the cloud in one outbox event and in the next snapshot, drives the next weather tick, and a cloud-side value the edge does not implement survives a save of other fields;
- every existing device series keeps its `seriesId`, its values and its place in the tray.

## Decisions

| Topic | Decision | Basis |
|---|---|---|
| Scope | Data view sources, the `et0_mm` / `etc_mm` / `global_radiation_wm2` channels, CSV through the analysis page, the zone provider selector, the `weather_source` round trip. | Phil, 2026-09-26: "keep all five". |
| Source model | `osi-history-helper/analysis.js` gains a `SOURCE_KINDS` object (shape in "Source kinds"); today's path becomes kind `device`. Each kind names its table, owner column, time column, native step, and per channel the column, bucket statistic and plot offset. | Controller brief. One read path for four tables. |
| Bucket statistic | `sum` for hourly totals (provider and station `rain_mm`, provider `et0_mm`) and for the daily record; `mean` for every other channel. The S2120's `rain_mm_per_hour` in `device_data` is a sampled rate and keeps `mean`. | A daily bucket of hourly totals is their sum; today every bucket takes the mean (`aggToPoints`, `analysis.js` lines 232–251). |
| Partial sums | A summed bucket carries `count` and `expected` (24 for a daily bucket of an hourly kind, 168 for a weekly one, 7 for a weekly bucket of the daily kind) and `quality: 'partial'` when `count < expected`; the tooltip adds "n of N h" (or "n of N d"). | Data review I7, controller ruling. |
| Daily buckets | The two hourly weather kinds bucket days by the zone's timezone; weekly spans start at the range start for every kind; device series keep UTC days. | Chair fix 3: the provider daily sum then matches the agronomy row of the same local day. |
| Period unit | A summed channel's series `unit` names the period of a point: `mm/h` for raw and hourly points of the hourly kinds, `mm/d` for daily buckets and the daily kind, `mm/wk` for weekly buckets. Catalogue entries keep the manifest unit. | UX blocker B2, ruling Q1. |
| Plot time | Open-Meteo temperature, humidity and wind points sit at `hour_start + 1 h`, the instant they describe; every other hourly channel at `hour_start`; daily rows at local midnight. | Ruling Q5. Storage stays as sub-project 1 left it. |
| Catalogue | One entry per zone, source and channel; `seriesId = sha256(zoneId\|cardType\|sourceKey\|channelKey)[0:16]` unchanged. Two zones sharing a location get two entries that read the same rows. Entries gain `sourceKind`. | The GUI recomputes the id (`analysisWorkspaceStorage.ts` lines 103–110); saved views keep working. |
| New channels | `global_radiation_wm2`, `et0_mm`, `etc_mm` in `channels.json`, `analysis.js` `CHANNELS` and `VALID_EXPORT_CHANNEL_KEYS`, with `edgeField: null`. Device sources do not list them, through one named set `DEVICE_EXCLUDED_CHANNELS` (spec decision). | Parity verifier rules; without the exclusion every default-path environment device would gain three disabled "unsupported" rows. |
| Metric preset | "Metric across zones" lists and selects device entries only. | Data review I6, UX I7. |
| CSV | The analysis page's client-side CSV (`src/analysis/csv.ts`) covers every plotted series; for a daily-cadence series `timestamp` is the zone-local date `YYYY-MM-DD`, otherwise the ISO instant. The zone endpoint `/api/history/zones/:id/export.csv` reads `device_data` only and stays as it is. | Controller ruling (CSV scope); ruling Q2 (date). |
| Zone selector | `<select>` "Weather provider" in `ZoneConfigModal`, after the Device GPS panel: auto ("Gateway default (MeteoSwiss)", the gateway's resolved default), open_meteo, meteoswiss, local ("Local weather station only"); a stored value outside these four is a fifth, disabled option and is never rewritten unless the user picks another. `AdvancedScheduleDrawer` does not get the selector (spec decision). | Controller brief; ruling Q4; UX I8; chair M2. |
| Round trip | Edge PUT → `irrigation_zones.weather_source` → `trg_sync_zones_outbox_au` emits `ZONE_CONFIG_UPSERTED` on a provider change (migration 0063) and carries the `weather_source` key in the zone update payload and both snapshots only when the stored value is not `auto`, or, for the update event only, when it changed in that update (final review I1: a reset to `auto` is sent exactly once; otherwise the key is absent, never null); the 0046 insert trigger is unchanged (a zone is inserted with `auto`; its first change emits the field under this rule). Cloud → edge through legacy `UPSERT_ZONE_CONFIG` / `UPSERT_ZONE` ("Build UPDATE SQL") and protected `UPSERT_ZONE` (`osi-zone-commands`). | The cloud applies the field from edge events and bootstrap already (`EdgeSyncService.upsertZone`, osi-server origin/main line 1112). Chair fix 1; final review I1 (unconditional emission risked a silent default overwrite before sub-project 4 lands). |
| Ownership | After sub-project 4 the edge owns `weather_source`: the cloud applies it from edge events and snapshots, sends cloud edits as commands gated on `zone_config_weather_source_v1`, and `applyCloudOwnedFields` stops writing it. | Data review B1, controller ruling. |
| Capability | `zone_config_weather_source_v1` joins `syncCapabilities` in `al-link-build-req`, `sync-bootstrap-build` and `sync-force-build`. | Chair fix 2; precedent `entity_name_commands_v1`. |
| Trigger ownership | `trg_sync_zones_outbox_au` stays owned by the boot node. Its body changes in `scripts/sync-trigger-source.json`, the generator rewrites the boot node's `triggers` array, and 0063 plus `seed-blank.sql` carry the same body. The migration-owned trigger lists do not gain it (spec decision). | `sync-init-fn` drops and recreates this trigger on every Node-RED start; a body changed only by a migration would be reverted at the next boot. Precedent: #337 (0058). |
| Contract | `resources.schema.json` Zone gains optional `weather_source` (string, 1 to 20 characters of `[a-z_]`); no enum. | The cloud's column is `VARCHAR(20)` and its set is wider than the edge's. |
| GUI copy | Tooltips only: one `HelpTip` beside the selector label and one beside the aggregation badge; the chart tooltip's partial marker. No note, caption or banner. | Phil, 2026-09-26 (daily agronomy spec, same rule); ruling Q3. |
| Cloud | Sub-project 4, except the copies on the same-named osi-server branch that this PR's CI and that branch's CI need (see "Landing requirements"). | `migrations.yml` lines 185–210 and osi-server `backend-ci.yml` lines 66–103 compare against the same-named branch of the other repo. |

## Current state

The analysis backend is one function node, `analysis-api-router-fn` (flows.json line 10676), calling `buildAnalysisCatalog` and `resolveAnalysisSeries` in `osi-history-helper/analysis.js`. The catalogue walks each zone's devices through `deriveCardsForZone` and `sourceDevicesForCard`; `resolveAnalysisSeries` groups the selected entries by device EUI and runs one `SELECT … FROM device_data` per device (lines 453–492), then `aggregateRows` per channel. `aggregateRows` (`osi-history-helper/index.js` lines 1051–1143) computes min, max, mean, median, latest and `sampleCount` per bucket through `statsForValues` (lines 732–748); there is no sum. In raw mode it drops null values (line 1079). Daily buckets follow local midnights of `options.timezone` when one is passed (`aggregationBuckets`, lines 1010–1049); the analysis module passes none today.

No reader exists for `weather_provider_hours` or `weather_station_hours` outside `osi-agronomy-daily`. `irrigation_zones.weather_source` (migration 0060, `TEXT NOT NULL DEFAULT 'auto'`) is read by `osi-weather-provider.resolveProvider` (lines 21–27) and by the daily writer, and appears nowhere in flows.json: not in the zone GET/PUT nodes, either command path, the zone outbox trigger, the two snapshot builders or the GUI. `scripts/test-zone-command-path.js` lines 467–485 pin that a `weather_source` field in a protected `UPSERT_ZONE` is `REJECTED_PERMANENT`.

On osi-server origin/main (`cce3e8b6`) the field is cloud-owned. `IrrigationZoneController.commandPayload` removes `weatherSource` from every zone command (line 978), `applyCloudOwnedFields` (line 1016) writes it to the cloud's canonical row, and `EdgeSyncService.upsertZone` overwrites the stored value whenever an edge zone payload carries `weather_source` (line 1112). The edge's sync capabilities are a literal array in three nodes (`al-link-build-req`, `sync-bootstrap-build`, `sync-force-build`), pinned by `verify-sync-flow.js` lines 2068–2072 and listed in `AGENTS.md` lines 72–77.

## Source kinds

`SOURCE_KINDS` in `analysis.js`, one object per kind. The column names are constants; a selector only chooses among them, so no identifier from a request reaches SQL.

```js
const SOURCE_KINDS = {
  device: {
    table: 'device_data', ownerColumn: 'deveui', timeColumn: 'recorded_at',
    nativeStep: null,   // sampled
    channels: null,     // today's path: CHANNELS[].edgeField, stat 'mean', no offset
  },
  weather_provider: {
    table: 'weather_provider_hours', ownerColumn: 'location_key', timeColumn: 'hour_start',
    nativeStep: 'hour',
    channels: {
      ambient_temperature:  { column: 'air_temperature_c',     stat: 'mean', offsetHours: { open_meteo: 1 } },
      relative_humidity:    { column: 'relative_humidity_pct', stat: 'mean', offsetHours: { open_meteo: 1 } },
      rain_mm_per_hour:     { column: 'rain_mm',               stat: 'sum' },
      wind_speed_mps:       { column: 'wind_speed_mps',        stat: 'mean', offsetHours: { open_meteo: 1 } },
      global_radiation_wm2: { column: 'global_radiation_wm2',  stat: 'mean' },
      et0_mm:               { column: 'et0_mm',                stat: 'sum' },
    },
  },
  weather_station: {
    table: 'weather_station_hours', ownerColumn: 'deveui', timeColumn: 'hour_start',
    nativeStep: 'hour',
    channels: { /* rows of the channel table below, stat as listed, no offset */ },
  },
  zone_daily_agronomy: {
    table: 'zone_daily_agronomy', ownerColumn: 'zone_id', timeColumn: 'date',
    nativeStep: 'day',
    channels: { et0_mm: { column: 'et0_mm', stat: 'sum' }, etc_mm: { column: 'etc_mm', stat: 'sum' } },
  },
};
```

`device` is a real entry whose `channels: null` sends the request down today's code (`channelMeta(...).edgeField`, `sqlIdent`, `mean` at every level). `offsetHours` is keyed by the location row's `provider`; a missing key means no offset. The key order of each `channels` object is the order of the entries in the catalogue.

| Kind | channelKey | Column | Statistic | Plot offset |
|---|---|---|---|---|
| `device` | every channel as today | its `edgeField` | `mean` | none |
| `weather_provider` | `ambient_temperature` | `air_temperature_c` | `mean` | +1 h for Open-Meteo, none for MeteoSwiss |
| `weather_provider` | `relative_humidity` | `relative_humidity_pct` | `mean` | +1 h for Open-Meteo, none for MeteoSwiss |
| `weather_provider` | `rain_mm_per_hour` | `rain_mm` | `sum` | none |
| `weather_provider` | `wind_speed_mps` | `wind_speed_mps` | `mean` | +1 h for Open-Meteo, none for MeteoSwiss |
| `weather_provider` | `global_radiation_wm2` | `global_radiation_wm2` | `mean` | none |
| `weather_provider` | `et0_mm` | `et0_mm` | `sum` | none |
| `weather_station` | `ambient_temperature` | `air_temperature_c` | `mean` | none |
| `weather_station` | `relative_humidity` | `relative_humidity_pct` | `mean` | none |
| `weather_station` | `wind_speed_mps` | `wind_speed_mps` | `mean` | none |
| `weather_station` | `barometric_pressure_hpa` | `pressure_hpa` | `mean` | none |
| `weather_station` | `light_lux` | `light_lux` | `mean` | none |
| `weather_station` | `global_radiation_wm2` | `global_radiation_wm2` | `mean` | none |
| `weather_station` | `rain_mm_per_hour` | `rain_mm` | `sum` | none |
| `zone_daily_agronomy` | `et0_mm` | `et0_mm` | `sum` | local midnight of `date` |
| `zone_daily_agronomy` | `etc_mm` | `etc_mm` | `sum` | local midnight of `date` |

Open-Meteo reports temperature, humidity and wind at the end of the hour its stamp closes, and sub-project 1 stores them at `hour_start = stamp − 1 h` (`osi-weather-provider` `normalizeOpenMeteo`, lines 130–133). The offset puts each point back at the instant it describes. MeteoSwiss values are hourly means or totals and stay at `hour_start`, as do Open-Meteo's accumulated or averaged channels (rain, radiation, ET0). Storing the instantaneous values at their own instant is a weather-store change left as a follow-up.

The channel keys are the manifest's, so a provider temperature and a device temperature share axis and unit. For summed channels the series unit names the period instead of the manifest unit ("Series response").

**Expected counts.** A summed bucket above the native step carries `expected`:

| Kind | Levels at or below the native step (rows are points) | `daily` bucket | `weekly` bucket |
|---|---|---|---|
| `weather_provider`, `weather_station` | `raw`, `15m`, `hourly`: `expected: null` | 24 | 168 |
| `zone_daily_agronomy` | `raw`, `15m`, `hourly`, `daily`: `expected: null` | (rows are points) | 7 |

`quality` is `'partial'` when `0 < count < expected`, otherwise `null`. A bucket with no value is a null point. The fixed 24 marks the first and last bucket of a range (which start at the range start or end at its end) and any day with missing hours; the 23-hour local day of the spring clock change is always marked partial, and the 25-hour autumn day counts up to 25 of 24 without a mark (spec decision). A partial bucket still reports the sum of the hours present.

## Catalogue entries

`buildAnalysisCatalog` keeps its signature and its zone query. After a zone's device entries it appends, in this order (spec decision), the provider entry, the station entries ordered by deveui, and the daily agronomy entry. Channels within a source follow the channel map's order. Every new entry has `cardType: 'environment'`, `availability: 'available'`, `depthCm: null`, the zone's `hubEui`, and `displayName = <deviceName> - <channel label>` as for devices. Every entry, devices included, gains `sourceKind` (`'device'`, `'weather_provider'`, `'weather_station'` or `'zone_daily_agronomy'`), which the GUI's preset reads. Source names come from the backend in English and are not localised, like today's channel labels.

**Dependencies.** `createAnalysis` receives four more functions from `index.js` (lines 2739–2749): `zoneLocations`, which `index.js` requires from `../osi-weather-provider` (the sibling require `osi-agronomy-daily` line 5 uses; `osi-weather-provider/index.js` lines 523–541, exported at line 714), and three of `osi-history-helper/index.js`'s own: `zoneDateStartIso` (line 1840), `normalizeTimezone` (line 2347) and `localDateKey` (line 2411). The deployment default is resolved inside `buildAnalysisCatalog` as `options.weatherProviderDefault`, else `process.env.OSI_WEATHER_PROVIDER_DEFAULT` (set by `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` line 457). Only tests pass the option; the router relies on the environment, so `analysis-api-router-fn` and its pinned call strings stay unchanged (spec decision).

**Provider location.** When the zone query returns at least one zone, the catalogue calls `zoneLocations(adapter, deploymentDefault)` once, through the adapter `{ all: (sql, params) => dbAll(db, sql, params) }`, because the router passes an `osi-db-helper` handle and `zoneLocations` awaits `db.all` (spec decision; `dbAll`, `index.js` lines 1145–1159, handles callback and promise forms). The result covers every live zone and is indexed by `zone.id`; zones outside the catalogue's own list are ignored. The keys found are then read in one query:

```sql
SELECT location_key, provider, latitude, longitude, station_id, station_name, station_distance_km
FROM weather_locations WHERE location_key IN (?, …)
```

skipped when no zone has a key. A zone gets a provider entry when its `zoneLocations` result has a `locationKey` (provider not `local`, coordinates on the zone or its gateway) and that key has a `weather_locations` row. `sourceKey = 'weather-src-' + sha256(locationKey).hex.slice(0, 12)`. `deviceName`:

- Open-Meteo: `Open-Meteo 46.80°N 6.95°E`, the location row's coordinates to two decimals, `S` / `W` for negative values with the absolute number (spec decision);
- MeteoSwiss with a resolved station: `MeteoSwiss PAY Payerne (12 km)`, from `station_id`, `station_name` and `station_distance_km` rounded to whole kilometres; a missing name or distance is left out (spec decision);
- MeteoSwiss before a station is resolved: `MeteoSwiss 46.80°N 6.95°E` (spec decision).

**Station hours.** One query per zone, after its device query:

```sql
SELECT d.* FROM weather_station_zones wsz JOIN devices d ON d.deveui = wsz.deveui
WHERE wsz.zone_id = ? AND d.deleted_at IS NULL AND d.type_id = 'SENSECAP_S2120'
  [AND d.user_id = ?]
ORDER BY d.deveui ASC
```

The `user_id` filter applies in the legacy owner-only mode, as the device query does (`analysis.js` lines 369–373); in scoped mode the zone list is the only bound (spec decision). The group owner is the raw `devices.deveui`, the value `osi-station-hours` stores (`STATIONS_SQL`, line 22). `sourceKey = 'station-src-' + sha256(normalizeDeveui(deveui)).hex.slice(0, 12)`, distinct from the same device's `environment-src-…` key. `deviceName = displayDeviceName(device, index) + ' (hourly)'`, with `index` the station's position in this list (spec decision), for example `demo-s2120 (hourly)`.

**Daily agronomy.** Every zone of the catalogue: `sourceKey = 'agronomy-src-zone'`, `deviceName = <zone name> daily agronomy` (`Zone <id> daily agronomy` when the name is empty, spec decision), channels `et0_mm` and `etc_mm`.

**Entry bookkeeping.** `entriesById` stores `{ ...entry, owner, timezone, provider }`: `owner` is the deveui (device), location key (provider), station deveui (station) or zone id (daily); `timezone` is `normalizeTimezone(zone.timezone)` for every kind; `provider` is the location row's `provider` for the provider kind and `null` otherwise. Device entries keep `deveui` as today.

**Device entries.** `analysis.js` gains `const DEVICE_EXCLUDED_CHANNELS = new Set(['global_radiation_wm2', 'et0_mm', 'etc_mm'])` with a comment naming this spec, applied in `cardChannels` (lines 105–110), so no device source lists the three keys. A general "device sources list only channels with an `edgeField`" rule is not available: `vwc` (`edgeField: null`) is listed today as an unsupported soil row, and that stays.

**Scope.** The zone filter (`zoneUuids` or the owner's zones) bounds every entry, because every new entry hangs off a zone of the catalogue. Tray grouping (`AnalysisSeriesTray.tsx` lines 29–53, by `hubEui|zoneId`, then `deviceName`) needs no change; each new `deviceName` forms its own group under the zone.

A location no zone resolves to any more (after a provider change) keeps its rows, as the weather store spec left open for this sub-project; the data view does not show it (spec decision). A MeteoSwiss series keeps its `seriesId` when the station is re-resolved and takes the current station's name; older rows may come from the previous station.

## Series resolution

`resolveAnalysisSeries` keeps its order of checks: at most 25 selectors, `normalizeRange` (at most 400 days), `resolveAggregation` once for the request, then the catalogue.

**Grouping.** Selected entries are grouped by `sourceKind + '|' + owner`. Each group runs one SELECT. The 30 000-row counter is shared by all groups, as it is shared by all devices today: each SELECT asks for `LIMIT remaining + 1` rows, and the same `413` with "Narrow the date range or pick a coarser granularity." fires when a group returns more than `remaining` or `remaining` reaches zero. A device entry whose channel has no `edgeField` is still dropped as `unsupported`; that check applies to kind `device` only.

**SQL bounds.**

- Hourly kinds: `SELECT hour_start, <columns> FROM <table> WHERE <owner column> = ? AND hour_start >= ? AND hour_start < ? ORDER BY hour_start ASC LIMIT ?`, with the unique columns of the group's selected channels. The lower bound is `from` floored to whole seconds, one hour earlier for the provider kind so an offset point at `from` is found; the upper bound is `to` rounded up to whole seconds. Both are written in the stored form `YYYY-MM-DDTHH:MM:SSZ` (spec decision; `osi-station-hours/index.js` lines 5–7 record the two stamp forms). Each channel's points are then filtered on their plotted instant to `[from, to)`.
- Daily kind: `SELECT date, et0_mm, etc_mm FROM zone_daily_agronomy WHERE zone_id = ? AND date >= ? AND date <= ? ORDER BY date ASC LIMIT ?`, with the bounds `localDateKey(from, tz)` and `localDateKey(to − 1 ms, tz)`; rows whose local midnight falls outside `[from, to)` are dropped (spec decision).

**Row mapping.** Per selected channel, each row becomes `{ recorded_at, [channelKey]: value }`. For the hourly kinds `recorded_at = new Date(Date.parse(hour_start) + offsetHours × 3 600 000).toISOString()`, so points carry the `…:00.000Z` form of device points (spec decision). For the daily kind `recorded_at = zoneDateStartIso(date, timezone)`, the UTC instant of local midnight.

**Points.** The rule depends on the applied level and the kind's native step (spec decision):

- When the bucket is no wider than the native step (hourly kinds at `raw`, `15m`, `hourly`; the daily kind at `raw`, `15m`, `hourly`, `daily`), a new function `rowsToPoints` turns the mapped rows into points: `{ t: recorded_at, value, count: value === null ? 0 : 1, expected: null, quality: null }`. A stored null stays a null point. Where two consecutive rows are more than one native step apart (an hour; for the daily kind, a date that is not the day after the previous one), a point `{ t, value: null, count: 0, expected: null, quality: null }` is inserted at the previous `t` plus one step (for the daily kind, the local midnight of the next date), so the line breaks at a missing hour or day as it does at an empty bucket. Bucketing hourly rows into 15-minute slots would leave three empty buckets around every value.
- Above the native step, the mapped rows go through `aggregateRows` with `channels: [{ id: channelKey, field: channelKey, unit }]` and `timezone: entry.timezone`, and then through `aggToPoints(aggregate, channelKey, { stat, expected })`. With that third argument, `value = stats.sum` for a `sum` channel and `stats.mean` otherwise, `count = stats.sampleCount` (rows in the bucket with a value), `expected` as in the table of "Source kinds" for a `sum` channel and `null` for a `mean` channel, and `quality = 'partial'` or `null` as defined there. `coverageConfidence` is not used for the new kinds: it describes the cadence of a synthetic source and carries no information here.
- Device entries are unchanged: `aggToPoints(aggregate, channelKey)` without the third argument keeps today's body (`mean`, `count = sampleCount`, `quality = coverageConfidence`, no `expected` key), `aggregateRows` at every level, no timezone.

**`sum` in `aggregateRows`.** `statsForValues` adds `sum: roundTo(sum)` (three decimals, the total it already computes for the mean), and the empty-bucket object (lines 1106–1114, inside the bucket loop) gets `sum: null`. The change is additive for every consumer that copies named fields: `osi-history-router`'s `buildSeriesFromAggregate` (lines 311–341), the rollup writer (`index.js` lines 1216–1233) and `osi-journal/context.js` (lines 360 and 621). Neither the golden vectors nor `history_channel_rollups` change; `capture-history-router-vectors.js --verify` proves it. One test deep-equals the stats object and is updated ("Testing").

**Series response.** Each series gains two fields; the rest is unchanged (`seriesId`, `resolved`, `label`, `unit`, `points`, `truncated`):

- `cadence`: `'daily'` when each point stands for one zone-local day (the daily kind at `raw` to `daily`; the hourly kinds at `daily`), `'hourly'` for every other series, whose points are instants (device series, hourly points, weekly spans);
- `timezone`: the entry's normalised zone timezone.

`unit` for a `sum` channel is the period unit, derived from the manifest unit's amount (`mm`): `mm/h` for the hourly kinds at `raw`, `15m` and `hourly`; `mm/d` for the hourly kinds at `daily` and for the daily kind at `raw` to `daily`; `mm/wk` for any kind at `weekly`. Every other series keeps the entry's unit, so the S2120's device rain rate stays `mm/h`. The GUI groups panels by series unit (`groupByUnit`, `unitGrouping.ts`), so provider daily rain (`mm/d`) and the device's mean rate (`mm/h`) land on separate panels, and hourly ET0 (`mm/h`) and daily ET0 (`mm/d`) do too.

**Time semantics.**

- An hourly row is plotted at `hour_start`, the start of the hour it covers, except the three Open-Meteo instantaneous channels, plotted at `hour_start + 1 h`. Provider rain, radiation and ET0 are that hour's total or mean; MeteoSwiss values are hourly means or totals. Station values are means (rain a sum) over the samples in the hour.
- A daily row is plotted at local midnight of its date in the zone's timezone (an invalid timezone falls back to UTC through `normalizeTimezone`).
- Daily buckets of the hourly kinds follow the zone's local midnights: the first bucket starts at the range start and ends at the next local midnight, as `aggregationBuckets` builds them when a timezone is passed. Weekly buckets are seven-day spans from the range start for every kind. Device series keep UTC days, so the day boundary mismatch moves from provider-versus-record to provider-versus-device; the latter is the lesser harm, because device daily buckets are means, not totals.
- `aggregation.applied` in the response stays the request's level. A 36-hour range reports `15m` while a provider series in it has hourly points; the aggregation badge's HelpTip says so.

## Channel manifest

Appended after the last entry (`soil_vic_10`) of `web/react-gui/src/channels/channels.json`, in this order (spec decision):

```json
  {
    "key": "global_radiation_wm2",
    "unit": "W/m²",
    "label": "Global radiation",
    "displayName": "Global radiation",
    "cardType": "environment",
    "category": "weather",
    "edgeField": null,
    "serverField": null,
    "exportable": true,
    "deprecated": false,
    "legacyAliases": []
  },
  {
    "key": "et0_mm",
    "unit": "mm",
    "label": "Reference ET (ET0)",
    "displayName": "Reference evapotranspiration",
    "cardType": "environment",
    "category": "weather",
    "edgeField": null,
    "serverField": null,
    "exportable": true,
    "deprecated": false,
    "legacyAliases": []
  },
  {
    "key": "etc_mm",
    "unit": "mm",
    "label": "Crop water demand (ETc)",
    "displayName": "Crop water demand",
    "cardType": "environment",
    "category": "weather",
    "edgeField": null,
    "serverField": null,
    "exportable": true,
    "deprecated": false,
    "legacyAliases": []
  }
```

The same three keys are appended to `analysis.js` `CHANNELS` (after `pipe_pressure_kpa`, same fields as the verifier's `normalizeAnalysisChannel` compares) and to `VALID_EXPORT_CHANNEL_KEYS` in `index.js` (after `pipe_pressure_kpa`). `edge-channels.json` in both profiles is unchanged, because it lists only entries with an `edgeField`. `docs/channel-manifest.md` line 62 records the new SHA-256; the line is already stale today (it records `aceaa8c2…`, the file hashes to `3a44492e…`, which osi-server's `ChannelManifestTest` pins). No script reads that line, so the update is documentation only.

The zone export endpoint accepts `channels=et0_mm` because the key is now valid, and returns no column for it: `exportChannelsForCard` (lines 1952–1957) filters `channelsForCard`, which lists `device_data` fields only. `vwc` (also `edgeField: null`) behaves this way today. A test pins it.

## Analysis page (GUI)

**Tray labels.** `channelLabel` in `AnalysisSeriesTray.tsx` (lines 60–66) strips a leading `${deviceName} - ` as well as `${deviceName}: `. The backend joins with ` - ` (`analysis.js` line 402), so today no prefix is ever stripped; after the change every tray button, device buttons included, shows the channel label under its source group. The tray search haystack is unchanged.

**Metric preset.** `applyMetricPreset` (`CrossZoneAnalysisPage.tsx` lines 120–129) and `availableMetricOptions` (`MetricAcrossZonesPicker.tsx` lines 25–40) take entries with `sourceKind === 'device'` only. The preset buttons and their labels stay as they are today, the three new keys get no button, and a preset never selects identical provider series of zones sharing a location.

**Aggregation badge.** A `HelpTip` follows the badge (`CrossZoneAnalysisPage.tsx` lines 204–211), with `analysis.aggregation.helpLabel` "About aggregation" and `analysis.aggregation.help`:

> Raw points sit at the reading's time; at 15-minute, hourly, daily and weekly aggregation each point sits at the start of its period, and for weather sources a day is the zone's local day. Rain, ET0 and ETc from a weather provider, a station's hourly record or daily agronomy are totals for that period, and other values are means. Open-Meteo hourly temperature, humidity and wind are values at the time shown. Weather sources show no finer detail than one hour, or one day for daily agronomy.

**Partial marker.** A point with `quality: 'partial'` shows its tooltip value followed by `analysis.tooltip.partialHours` " ({{count}} of {{expected}} h)", or `analysis.tooltip.partialDays` " ({{count}} of {{expected}} d)" for a weekly bucket of the daily kind (spec decision: the second key covers the one case counted in days). `buildTimeSeriesOption` and `buildSmallMultiplesOption` take a `formatPartial(point, series)` callback from the panel, and the tooltip uses it for the hovered point of each series.

**Symbols.** A series with `cadence: 'daily'` is drawn with `showSymbol: true` and `symbolSize: 4` (`lineSeries`, `echartsOptions.ts` line 84), so a valid day between two null days is visible (spec decision). Other series keep `showSymbol: false`; an isolated hour between gaps stays invisible, as an isolated device sample is today.

**CSV.** `toTidyCsv` (`csv.ts`) writes, per point:

- `timestamp`: for `cadence: 'daily'` the local date `YYYY-MM-DD` of `t` in the series `timezone`, otherwise the ISO instant `t` as today (ruling Q2). A Zurich agronomy row for 2026-09-25 therefore exports as `2026-09-25`, not `2026-09-24T22:00:00.000Z`;
- `unit`: the series unit, so daily totals read `mm/d`;
- `value`: a mean for most channels and a period total for rain, ET0 and ETc; a partial total is written as the sum of the hours present, with no marker (the file has no quality column, spec decision);
- stored and inserted nulls: rows with an empty `value`, as today.

**Types.** `AnalysisCatalogEntry` gains `sourceKind: string`; `AnalysisSeries` gains `cadence: 'hourly' | 'daily'` and `timezone: string | null`; `AnalysisPoint` gains `expected?: number | null`.

**Phones.** `AnalysisRoute.tsx` sends every non-desktop browser to `/history`, and the history cards gain nothing; on phones and tablets the zone selector is the only visible change.

## Zone provider selector

`ZoneConfigModal.tsx` gains a field after the Device GPS panel that closes the location section (lines 553–622), before the divider above Notes (line 626). It is laid out like the stage field (lines 492–516): a label row with a `HelpTip`, then a native `<select>` bound to a state variable `weatherSource`, initialised from `zone.weatherSource ?? 'auto'`.

| Value | Label key (`devices.json`) | English |
|---|---|---|
| `auto` | `zoneConfig.weatherProviderOption.auto` | `Gateway default ({{provider}})` |
| `open_meteo` | `zoneConfig.weatherProviderOption.open_meteo` | Open-Meteo |
| `meteoswiss` | `zoneConfig.weatherProviderOption.meteoswiss` | MeteoSwiss |
| `local` | `zoneConfig.weatherProviderOption.local` | Local weather station only |
| any other stored value | `zoneConfig.weatherProviderCloud` | `{{value}} (cloud provider)` |

`{{provider}}` is the translated option label of `zone.weatherSourceDefault` (`open_meteo` or `meteoswiss`), so a Swiss gateway shows "Gateway default (MeteoSwiss)" and the de-CH bundle "… (MeteoSchweiz)".

Further keys: `zoneConfig.weatherProvider` "Weather provider" (the label), `zoneConfig.weatherProviderHelpLabel` "About the weather provider", and `zoneConfig.weatherProviderHelp`:

> Sets where this zone's hourly weather history comes from, and its daily ET0 unless an assigned weather station has a complete day, which takes precedence. MeteoSwiss covers Switzerland. With Local weather station only, the gateway downloads no weather history for this zone, so without an assigned station it gets no ET0. The weather forecast does not change.

Each sentence matches the code: `osi-agronomy-daily` `resolveDay` (lines 155–197) tries the station's FAO-56 ET0 first and the provider's hourly sum second; `resolveMeteoSwissStation` throws `outside MeteoSwiss coverage` beyond 15 km of a SwissMetNet station (`METEOSWISS_MAX_KM`, line 176); `local` makes `resolveProvider` return `null`, so no history is fetched and, without a station, the day ends as `no_source`; the forecast path never reads `weather_source` (it appears nowhere in flows.json).

The agency's official name is used per language: MeteoSchweiz (de-CH), MétéoSuisse (fr), MeteoSvizzera (it), MeteoSwiss (en, es, pt, lg). Open-Meteo is the same everywhere. The identical pairs (`Open-Meteo` in the five European locales, `MeteoSwiss` in es and pt) go into `REVIEWED_IDENTICAL` in `tests/zoneFormLocales.test.ts` (spec decision). All eight keys are added to `en`, `de-CH`, `fr`, `it`, `es`, `pt` and `lg` (`lg` carries the English text), listed in `KEYS` of `tests/zoneFormLocales.test.ts`, and recorded in a new row of `docs/i18n/pending-luganda-translations.md`, which also lists the four `analysis.*` keys above. The German copy avoids ß (the test's de-CH rule).

**Unknown-value rule.** A stored value outside the four is rendered as an extra `<option value={stored} disabled>` with the cloud-provider label, so the select shows it selected; once the user picks another option it cannot be re-selected (spec decision). `buildConfigPayload` sends `weatherSource` only when the selection differs from the stored value, so saving other fields never rewrites it.

**GUI types.** `IrrigationZone` (`types/farming.ts`) gains `weather_source?: string | null`, `weatherSource?: string | null` and `weatherSourceDefault?: 'open_meteo' | 'meteoswiss' | null`; `RawIrrigationZone` (`services/api.ts` line 490) derives from `Partial<IrrigationZone>` and gets the snake-case field `weather_source_default?` beside them. `normaliseZone` (line 500) maps `weatherSource: z.weatherSource ?? z.weather_source ?? 'auto'` and `weatherSourceDefault: z.weatherSourceDefault ?? z.weather_source_default ?? 'open_meteo'`; the `updateConfig` payload type (line 609) gains `weatherSource?: string`.

**Other writers.** `AdvancedScheduleDrawer.tsx` (lines 100–108, 296) also calls `updateConfig` for stage, calibration key and timezone. It does not get the selector, because the provider depends on the location the modal edits (spec decision).

## Edge write path

**`zone-config-fn`** (flows.json line 5926) reads `b.weatherSource !== undefined ? b.weatherSource : b.weather_source`. Rules:

- `null` or a string that is empty after trimming stores `'auto'` (the column is `NOT NULL`; spec decision);
- otherwise the value is trimmed and lower-cased and must match `^[a-z_]{1,20}$`, which admits the four edge values and every cloud key (`openagri`, `agromonitoring`, …); anything else answers `400 {error: 'Weather provider must be 1 to 20 lower-case letters or underscores'}` (spec decision);
- a valid value adds `weather_source=<value>` to `sets`, so the existing `sync_version=COALESCE(sync_version,0)+1` bump covers it.

The node has two SELECTs: the ownership check reads `id,name` and stays; the re-select after the update adds `weather_source` to its column list, and the response object gains `weather_source` and `weather_source_default`. The node gets no inline `ALTER` (the column comes from migration 0060).

**Zone list.** `get-zones-query` (line 1242) adds `iz.weather_source` to its explicit column list. `get-zones-response` (line 1290) adds `weather_source: r.weather_source || 'auto'` and `weather_source_default`, computed once per request as the provider `auto` resolves to on this gateway: `String(env.get('OSI_WEATHER_PROVIDER_DEFAULT') || '').trim().toLowerCase() === 'meteoswiss' ? 'meteoswiss' : 'open_meteo'`, the same result as `resolveProvider('auto', …)` for the two providers the edge implements (spec decision: the field name; ruling Q4). `zone-config-fn` uses the same expression for its response.

**Size ratchet.** Each grown node gets a measured `node_allowances` entry in `scripts/verify-flows-size-ratchet-allowances.json`: existing entries for `zone-config-fn`, `get-zones-query`, `4f4a765f36cee6f3`, `sync-init-fn`, `sync-bootstrap-build`, `sync-force-build` and `al-link-build-req` are superseded with the new cumulative delta, and `get-zones-response` gets its first. The exact `expectedGrowth` pins for `sync-bootstrap-build`, `sync-force-build` and `al-link-build-req` in `scripts/verify-live-gateway-identity.js` (lines 1109, 1126, 1134) move to the same numbers. `total_allowance.delta` is re-measured over both profiles and its exact pin (line 1351, today `4138`) moves to the new number, with the node ids named in the reason. The `migrationPreflightHashes` pins (lines 406–409) hash only the preflight segment, which precedes the zone SELECT in both snapshot nodes, and do not move.

## Snapshots and capability

**Snapshots.** `sync-bootstrap-build` and `sync-force-build` each select an explicit zone column list and map an explicit object. Both add `iz.weather_source` to the SELECT and, beside `prediction_card_enabled`, spread `...(z.weather_source && z.weather_source !== 'auto' ? { weather_source: z.weather_source } : {})` into the zone map (final review, finding I1): the key is present only when the stored value is not `auto`, absent otherwise, never sent as a default the cloud did not choose. See "Ownership and deploy order" below for why the unconditional form this paragraph used to describe was replaced. The cloud applies bootstrap zones through the same `upsertZone` (`EdgeSyncService.java`).

**Capability.** `'zone_config_weather_source_v1'` is appended to the `syncCapabilities` array in `al-link-build-req`, `sync-bootstrap-build` and `sync-force-build`, after `'entity_name_commands_v1'`. It tells the cloud that this gateway stores `weather_source` from `UPSERT_ZONE_CONFIG`, legacy `UPSERT_ZONE` and protected `UPSERT_ZONE`. A gateway without it rejects a protected `UPSERT_ZONE` that carries the field (`REJECTED_PERMANENT`), so the cloud sends the field only to gateways that report the token.

**Pins in `verify-sync-flow.js`:** `iz.weather_source` and the conditional spread `"...(z.weather_source && z.weather_source !== 'auto' ? { weather_source: z.weather_source } : {})"` in "Build Cloud Bootstrap" and "Run Force Sync", and an `expectIncludesForEach` over the three nodes ("Build Cloud Bootstrap", "Build server auth request", "Run Force Sync") for `'zone_config_weather_source_v1'`.

**AGENTS.md.** The capability list (lines 72–77) gains the token and one sentence: the cloud sends `weather_source` in zone commands only to a gateway that reported it. The weather store paragraph (line 205) replaces "nothing syncs (each side fetches for itself)" with: the hourly tables do not sync and each side fetches for itself; a zone's `weather_source` travels in the zone events and snapshots, and after sub-project 4 the edge owns it.

## Ownership and deploy order

**Ownership.** After sub-project 4 the edge owns `weather_source` like every other zone config field. The cloud applies it from edge events and snapshots, sends a cloud edit as a zone command only to gateways that reported `zone_config_weather_source_v1`, and `applyCloudOwnedFields` stops writing it. The 0046 insert trigger is unchanged (a zone is inserted with `auto`; its first change emits the field under the rule below).

**Final review ruling (finding I1, supersedes the "emit unconditionally" decision above).** The original decision emitted the field in every zone update payload and both snapshots whether it changed or not, and rejected emitting only on change because that makes the field's truth depend on event history. The final review (`final-review-fable.md`) found that decision unsafe on its own: the bootstrap and force-sync snapshots run unattended on a roughly six-hour cadence (`AGENTS.md`), sending every zone's current value regardless of any user action, so a linked gateway on this branch would silently reset every cloud-chosen provider to the edge's `auto` default within six hours of the edge deploying — before sub-project 4 gives the cloud any way to tell an edge default from a deliberate edge choice. Controller ruling: the payload and both snapshots carry the `weather_source` key only when the stored value is not `auto`, or, for the trigger's update event only, when the value changed in this update (so a reset to `auto` is still sent, exactly once). This is not "emit only on change" — the key's presence in a snapshot depends only on the current value, not on history — it is "never send the default": with this rule an upgraded gateway cannot overwrite a provider chosen on the cloud unless somebody chooses a provider on the gateway itself, because the key is simply absent from every payload and snapshot for a zone that has never had its provider touched on the edge. This is the technical guard "Deploy order" below asked for, in place of a UCI flag gating the field.

**Deploy order.** Deploy the cloud side of sub-project 4 to a gateway's cloud before that edge reaches the gateway, so a provider chosen on the cloud is applied under capability-gated commands from the moment the edge starts sending. The omission rule above removes the blind, unattended overwrite risk for a zone whose edge value has never left `auto`, but it is not a substitute for the deploy order: a zone whose edge database already carries a non-`auto` value (a local choice made before sub-project 4, or residual data) still sends that value in its next event or snapshot, and until sub-project 4 ships, cloud main does not distinguish an edge default from a deliberate edge choice on that field. An unlinked gateway emits nothing (the trigger is gated on `sync_link_state`) and can take this release at any time.

**What `auto` means.** On the edge, `auto` is the gateway's UCI `osi-server.cloud.weather_provider_default` (`OSI_WEATHER_PROVIDER_DEFAULT`), `open_meteo` when unset or unknown (`resolveProvider`). On the cloud, `auto` walks `WeatherResolver`'s chain (OpenAgri, AgroMonitoring, Open-Meteo; `WeatherResolver.java` lines 47–62). A synced `auto` therefore does not mean both sides read the same provider; sub-project 4 decides whether that matters for the cloud's predictions.

## Migration 0063 and the trigger artefacts

`database/migrations/ordered/0063__zone_weather_source_sync.sql`, `-- risk: additive` (trigger redefinitions under `additive` have precedent in 0003, 0015, 0016 and 0017). It drops and recreates `trg_sync_zones_outbox_au` with the 0058 body plus three changes:

1. the `WHEN` list gains `OR COALESCE(NEW.weather_source,'auto') <> COALESCE(OLD.weather_source,'auto')`;
2. the `CASE` branch that yields `'ZONE_CONFIG_UPSERTED'` gains the same comparison, so a provider change alone selects that op (a change of `deleted_at` or coordinates still wins, as the `CASE` order is kept);
3. the payload's outer `CASE` (final review, finding I1) patches `'weather_source', COALESCE(NEW.weather_source, 'auto')` into the unchanged `json_object(...)` via `json_patch(...)` only when the stored value is not `auto` or changed in this update, and otherwise leaves the plain `json_object(...)` (no `weather_source` key) unchanged; the key is never an unconditional extra argument to `json_object(...)`.

The `CREATE TRIGGER` statement in 0063 is byte-identical to the new `sql` of the `trg_sync_zones_outbox_au` entry in `scripts/sync-trigger-source.json`, as 0058's is to today's entry (this trigger carries no `<GATEWAY_EUI>` token). The trigger stays gated on `sync_link_state` (`linked = 1`), so an unlinked gateway emits nothing. The insert trigger `trg_sync_zones_outbox_ai` (0046) is unchanged: its create event omits `weather_source`, the zone's first change emits the field, the cloud's default is `'auto'` too (osi-server `zone/IrrigationZone.java` line 69), and the next snapshot carries the value.

Because `sync-init-fn` drops and recreates this trigger on every start, the same body must reach the boot node. The artefacts, in the order #337 used for 0058:

- `scripts/sync-trigger-source.json`: the `trg_sync_zones_outbox_au` entry takes the new SQL; the `owners` statement list is unchanged (same trigger, same positions);
- `node scripts/generate-sync-trigger-source.js --write` renders the `triggers` array of `sync-init-fn` in both profiles; `--check` then passes;
- `database/seed-blank.sql`: the trigger at lines 2267–2352 takes the same body, pretty-printed as it is today;
- the seven bundled databases rebuilt by `scripts/build-seed-db.js`: `database/farming.db`, `web/react-gui/farming.db`, and `conf/{full_raspberrypi_bcm27xx_bcm2712, full_raspberrypi_bcm27xx_bcm2709, full_raspberrypi_bcm27xx_bcm2708, base_raspberrypi_bcm27xx_bcm2712, base_raspberrypi_bcm27xx_bcm2709}/files/usr/share/db/farming.db`;
- `database/migrations/ordered/CHECKSUMS.json` gains 0063;
- `MIGRATION_OWNED_TRIGGERS` (`verify-runtime-schema-parity.js` line 15) and `MIGRATION_OWNED_TRIGGER_NAMES` (`verify-trigger-body-parity.js` line 52) stay as they are (spec decision): listing a trigger the boot node still creates fails the name-set comparison, and the runner's boot-trigger grace path (`lib/osi-migrate/runner.js` lines 47–137) would then treat the boot rewrite as real drift;
- `scripts/verify-sync-flow.js` gains pins beside the prediction-card ones in "Sync Init Schema + Triggers": `COALESCE(NEW.weather_source,'auto') <> COALESCE(OLD.weather_source,'auto')` (the WHEN/CASE-op condition), `"CASE WHEN COALESCE(NEW.weather_source,'auto') <> 'auto' OR OLD.weather_source IS NOT NEW.weather_source THEN json_patch("` and `"json_object('weather_source', COALESCE(NEW.weather_source,'auto'))"` (the conditional payload patch); plus `iz.weather_source` in the zone list query, and the "Build UPDATE SQL" strings below;
- `sync-init-fn` gets a re-measured size allowance; its text changes only inside the generated region;
- `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`: the title reads "through 0063" (line 62) and `result.applied` ends `…, 60, 61, 62, 63]` (line 77);
- `scripts/reconcile-ledger-numbering.test.js`: the `pending` and `applied` lists at lines 554, 558 and 604 end `…, 58, 59, 60, 61, 62, 63]`. The daily agronomy branch extended them through 0062 in `6e0ea32cd`, which this branch's base carries, so the test is green on the base and this branch adds 63;
- `scripts/fixtures/terra-edge-selection/edge-selection-v1.json` and its `.sha256` are regenerated with `TERRA_EDGE_FIXTURE_OUT=scripts/fixtures/terra-edge-selection/edge-selection-v1.json node --test scripts/test-terra-selection-edge-acceptance.js`: the fixture holds the zone trigger payloads and the ACK `payloadHash` (`osi-zone-commands` `appliedAggregateHash`, lines 204–227), which gain `weather_source`. The osi-server copy pins an older osi-os commit and stays green; sub-project 4 refreshes it.

If the RAK10701 branch (its own 0060) lands first, 0060 to 0063 are renumbered together, as the daily agronomy spec states for 0060 to 0062.

A gateway never runs the new boot body against a database without the column: `deploy.sh` exits when the migration runner fails (line 1899) and flips the new flows only after a successful migration (`PAYLOAD_FLIPPED`, lines 48–54), and fresh images carry the rebuilt seed. SQLite accepts a trigger naming a missing column and fails the next `UPDATE irrigation_zones`, so this ordering matters. In the other direction, flows rolled back to the previous release on a database that has 0063 recreate the old boot body without `weather_source` at the next start: a provider change then stops emitting until the next upgrade, which is harmless and matches the 0058 precedent.

## Cloud to edge command paths

**Legacy path, "Build UPDATE SQL"** (`4f4a765f36cee6f3`, flows.json line 3864):

- `UPSERT_ZONE_CONFIG`: `var ws = cmd.weatherSource !== undefined ? cmd.weatherSource : cmd.weather_source;`. A present `null` or empty string stores `'auto'`, as the GUI PUT does. A present string is trimmed and lower-cased; if it matches `^[a-z_]{1,20}$` the branch pushes `sets.push('weather_source = ' + s(ws))`; an invalid string is ignored with one `node.warn` naming the zone UUID, and the rest of the command applies (spec decision, as the legacy `UPSERT_ZONE` treats an invalid name). Only an invalid string warns.
- Legacy `UPSERT_ZONE`: the `INSERT` column list gains `weather_source` with the valid value or `'auto'`; the `ON CONFLICT(zone_uuid) DO UPDATE SET` list gains `weather_source=` + (`excluded.weather_source` when a valid value was sent, else `irrigation_zones.weather_source`), the pattern `conflictName` uses for the name (spec decision).
- Pins in `verify-sync-flow.js`: `sets.push('weather_source = '` and `weather_source=excluded.weather_source`.

**Protected path, `osi-zone-commands`** (`normalizedZone`, lines 705–863):

- `weather_source` joins the optional fields of `exactObject` for `UPSERT_ZONE` and `UPSERT_ZONE_LOCATION` (not `DELETE_ZONE`);
- `null` or empty after trimming means absent, because `exactObject` is key-presence based and the protected zone object is a full snapshot; a present value is trimmed, lower-cased and must match `^[a-z_]{1,20}$`, else `malformed_command` (classified `REJECTED_PERMANENT`);
- `insertZone` (lines 892–928) writes the value, or `'auto'` when absent;
- `updateFullZone` (lines 940–970) adds `weather_source=?` only when the value is present, so a command without the field keeps the stored value (spec decision); `updateLocation` ignores it;
- `scripts/test-zone-command-path.js` lines 467–485 flip: the `weather_source: 'meteoblue'` case becomes `APPLIED` with the row stored as `meteoblue`, and a new case sent before it (`weather_source: 'Meteo-Blue!'`) is `REJECTED_PERMANENT` with no row.

**Terra** `UPSERT_ZONE_CONFIG` with `terraConfigurationOperation === true` keeps its exact field set (`osi-zone-commands` lines 84–172); Terra never sends the field.

Nothing arrives until sub-project 4 stops removing `weatherSource`, and it then sends the field only to gateways that report `zone_config_weather_source_v1`. A gateway on the previous release does not report it and receives no `weather_source`; its legacy path would ignore the unknown field anyway, and its protected path would reject the command.

## Contract change

`docs/contracts/sync-schema/resources.schema.json`, definition `Zone`, gains:

```json
"weather_source": {
  "type": "string",
  "minLength": 1,
  "maxLength": 20,
  "pattern": "^[a-z_]{1,20}$"
}
```

It is not in `required`, and no enum is enforced because the cloud's set (`auto`, `local`, `open_meteo`, `openagri`, `agromonitoring`, `meteoswiss`) is wider than the edge's. `maxLength` matches the cloud column `VARCHAR(20)` (spec decision). `events.schema.json` needs no change: `ZONE_CONFIG_UPSERTED` payloads allow additional properties. The addition is backward compatible, so the file keeps its version. The osi-server vendored copy changes on the same-named branch ("Landing requirements").

## Landing requirements

This PR's CI and the paired osi-server branch's CI each check out the same-named branch of the other repo, when it exists on the remote, and byte-compare shared files:

- osi-os `migrations.yml` (lines 25–40 checkout, 185–210 compare) compares `web/react-gui/src/channels/channels.json` with osi-server `frontend/src/channels/channels.json` and `backend/src/main/resources/channels.json`;
- osi-server `backend-ci.yml` (lines 66–103) runs `scripts/verify-edge-sync-contract-vendor.sh`, which compares `backend/src/test/resources/sync-contract/resources.schema.json` with this repo's file.

So an osi-server branch named exactly `feat/weather-data-view` must be **pushed** before this PR's CI can pass. It carries:

- both `channels.json` copies, byte-identical to the new file;
- `ChannelManifestTest.EXPECTED_SHA256` and the SHA in `scripts/verify-channel-manifest-sync.js`, `3a44492e…` → the new hash;
- the vendored `resources.schema.json`, byte-identical to the new file.

The edge CI needs only the two manifest copies; the other three keep the osi-server branch green. A local osi-server branch of that name exists (worktree `<osi-server>/.worktrees/weather-data-view`) at `cce3e8b6` with nothing on it; pushing it is Phil's call. The cloud's raw history query skips entries with a null `serverField` (`JdbcHistoryRawQueryRepository`, origin/main line 354), so the manifest copies are inert there.

The two branches merge in lockstep, back to back: once one merges, the other repo's main compares against the merged side's main and stays red until its partner merges.

## Paired cloud changes (sub-project 4)

- **Sending the field.** `IrrigationZoneController.commandPayload` stops removing `weatherSource` (origin/main line 978, including the comment above it), and the protected `UPSERT_ZONE` zone object carries `weather_source`, both only for gateways that reported `zone_config_weather_source_v1`.
- **Ownership.** `applyCloudOwnedFields` stops writing `weatherSource`; the cloud keeps applying the field from edge events and snapshots (`EdgeSyncService.upsertZone`, line 1112, through `WeatherSource.fromKey`). An edge value outside the cloud's set would become `auto` there; the edge GUI offers none.
- **Deploy order.** The cloud change lands on a cloud before this edge reaches any gateway linked to it ("Ownership and deploy order").
- **Terra fixture.** `backend/src/test/resources/contracts/terra-v2/edge-selection/` is refreshed from the regenerated edge fixture, so `TerraSelectionEdgeApplyIT` exercises the `weather_source` apply.
- **`auto`.** Whether the cloud's `auto` cascade should follow the gateway default for gateway-synced zones.
- **Data view.** Exposing provider hours, station hours and the daily record in the cloud's analysis page is a sub-project 4 decision; nothing syncs these tables.

## Sub-project boundaries

- Sub-project 3 (this spec): the analysis sources, the three channels, the analysis page changes, the zone selector, the `weather_source` round trip on the edge including snapshots and the capability, and the copies on the paired osi-server branch.
- Sub-project 4 (cloud): the rest of the paired changes above, the agronomy contract adoption listed in the daily agronomy spec §8, and the authority rule before any sync of `zone_daily_agronomy`.

## Existing behaviour kept

- Device sources: same entries, `sourceKey`s, `deviceName`s, channel lists and values; `mean` at every level; UTC daily buckets; nulls dropped in raw mode; point objects without `expected`.
- `seriesId = sha256(zoneId|cardType|sourceKey|channelKey)[0:16]` on both sides; saved views and workspaces resolve as before.
- Tray grouping by `hubEui|zoneId`, then `deviceName`; the 8-colour palette assigned by series order (`seriesColors.ts`); every series a line with `connectNulls: false`.
- The metric-across-zones preset's options, labels and selection for device channels.
- Limits: 25 selected series, 400 days, 30 000 rows per request, the same `413` messages.
- The router node `analysis-api-router-fn`, its four routes and its pinned call strings.
- The card router (`/api/history`), its rollups and golden vectors.
- The zone CSV endpoint's output.
- `edge-channels.json` and the device ingest paths.

## Global constraints

- flows.json is edited only by a one-shot script that runs the roundtrip guard, writes both profiles, and leaves them byte-identical; the `sync-init-fn` region is written only by `generate-sync-trigger-source.js --write`.
- Schema changes only through ordered migrations; `sync-init-fn` stays frozen (its trigger text moves only through the canonical source); seeds are rebuilt by `build-seed-db.js`, never hand-copied.
- No GUI build on the workstation (it runs out of memory); `npm run typecheck` and `npm run test:unit` only.
- Tooltips only; seven locales, `lg` in English, keys listed in the locale tests and the Luganda document.
- The size ratchet carries exact measured allowances and the identity pins move with them.
- No new helper module, so the helper registration surfaces (package.json `file:` deps, lock file, seed copy loop, `deploy.sh` fetch lines, osi-lib registry) do not change; `verify-helper-registration.js` stays green. `osi-history-helper` requiring its sibling `../osi-weather-provider` resolves on the gateway (`/srv/node-red/<name>`, `deploy.sh` lines 1402–1452) and in the repo; `osi-weather-provider` requires nothing, so there is no cycle.
- No flow node gains an `osiLib.require` of a db-shaped module, so the caller-binding policies in `verify-osi-lib-db-caller-binding.js` do not change.
- Every file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` that changes is mirrored byte for byte under `bcm2709`.

## Verifiers and gates

| Gate | What it checks here |
|---|---|
| `verify-channel-manifest-parity.js` | the three keys in `analysis.js` `CHANNELS` and `VALID_EXPORT_CHANNEL_KEYS` in both profiles; `edge-channels.json` unchanged |
| `migrations.yml` DD5 step | `channels.json` byte-identical with the pushed same-named osi-server branch's two copies |
| `verify-history-api-contract.js` | the router's pinned strings, untouched |
| `test-scoped-access-reads.js` | the router run directly on a seed-blank DB: owner-only and scoped catalogues, now including weather entries |
| `verify-flows-size-ratchet.js` + `verify-live-gateway-identity.js` | measured node allowances, the three `expectedGrowth` pins, the new total, the exact total pin |
| `verify-sync-flow.js` | the pins for the boot trigger, "Build UPDATE SQL", the zone list, both snapshots and the capability; the trigger list at line 1553 unchanged |
| `generate-sync-trigger-source.js --check` | canonical source = boot node regions = seed body |
| `verify-runtime-schema-parity.js`, `verify-trigger-body-parity.js` | trigger name sets and canonical bodies of seed and boot node agree |
| `node --test lib/osi-migrate/__tests__/*.test.js` | migration, seed and boot bodies agree token for token (`runner-boot-devices-rebuild-grace.test.js`); the corpus pin at 0063 |
| `verify-migrations.js`, `verify-seed-replay.js` | 0063 in the checksums; replay of 0001–0063 equals the seed |
| `reconcile-ledger-numbering.test.js` | ledger lists through 63 |
| `verify-no-stray-ddl.js` | no new DDL markers in any node |
| `verify-db-schema-consistency.js` | no table or column change |
| `verify-profile-parity.js` | both profiles identical |
| `test-zone-command-path.js` | the flipped case and the new rejection |
| `test-terra-selection-edge-acceptance.js` | the regenerated fixture and its hash |
| `osi-history-helper` `index.test.js`, `analysis.test.js` | `sum`, source kinds, points, partial marks (below) |
| `capture-history-router-vectors.js --verify` | golden vectors unchanged by `sum` |
| `test-zone-update-sync-version.js` | bundled-DB trigger events still correct with the extra payload key |
| `test-zone-weather-source.js` (new) | the edge write path, zone list, legacy command path and 0063 events |
| GUI `npm run typecheck`, `npm run test:unit` | types and the tests below, including `zoneFormLocales` and `analysis-locales` |
| `slop-check.js` | this spec, the plan, the Luganda document row |

## Error handling

- **`zoneLocations` or a weather query fails.** The error propagates; the router answers `500` with the error message, as for every other catalogue query (`analysis-api-router-fn` catch block). The catalogue does not fall back to devices only (spec decision), so a broken weather store is visible.
- **Missing location row.** A zone resolves to a location key but the weather tick has not yet created `weather_locations` for it (new zone, provider just changed): no provider entry until the next tick (every 1 800 s) creates the row.
- **Location without hours.** A row exists but no hours arrived (offline since creation, or MeteoSwiss chosen outside its coverage, where `resolveMeteoSwissStation` throws `outside MeteoSwiss coverage` and `last_error` records it): the entry is listed and its series has no points (spec decision).
- **Station without rows.** An assigned S2120 with no `weather_station_hours` yet: the entry is listed and returns no points (spec decision).
- **Missing hours or days.** Rows-as-points get a null point in the hole; a summed bucket with missing hours is marked partial.
- **Provider `local`.** No provider entry; the station and daily agronomy entries are listed as usual.
- **Zone without coordinates.** `zoneLocations` skips it, so no provider entry; the daily agronomy entry is listed and its rows (`null_reason = 'no_location'`) give null points.
- **Cloud value the edge does not implement** (`openagri`, `agromonitoring`): stored and sent back unchanged; the weather tick and the catalogue resolve it as the gateway default (`resolveProvider`); the selector shows it as the disabled fifth option.
- **Invalid values.** GUI PUT: `400` with the message above. Protected command: `REJECTED_PERMANENT` (`malformed_command`). Legacy command: the field is ignored with a warning.
- **Provider change.** The location key changes, so the provider source gets a new `sourceKey` and new `seriesId`s; saved views drop the old selectors and report them in `droppedSeriesIds` (`listAnalysisViews`, lines 502–522).
- **Range too large.** Unchanged: over 400 days, over 25 series, or over 30 000 rows across all groups answer `413` with a suggestion. The metric preset selects device entries only and adds no series.
- **Zone timezone invalid.** `normalizeTimezone` falls back to UTC for the daily kind's midnights, the daily buckets of the hourly kinds and the CSV date.

## Testing

`osi-history-helper/index.test.js`:
- "aggregateRows bucketed mode returns per-bucket stats and coverage" (line 259) deep-equals the stats object and gains `sum`;
- `aggregateRows` hourly and daily buckets carry `sum` equal to the total of the bucket's values, rounded as `mean` is; an empty bucket has `sum: null`; with `timezone: 'Europe/Zurich'` a daily bucket ends at local midnight;
- `buildZoneExportCsv` with `channels: 'et0_mm'` returns the header only and no error.

`osi-history-helper/analysis.test.js` (a scratch `node:sqlite` DB from `seed-blank.sql`, plus one run through a real `osi-db-helper` handle so the `zoneLocations` adapter is exercised as the router exercises it):
- the existing catalogue tests (lines 59–187) are updated: their `createAnalysis` mocks inject `zoneLocations`, `zoneDateStartIso`, `normalizeTimezone` and `localDateKey`, their `dbAll` mocks answer the station and location queries with `[]`, the call-order assertions at lines 84–87 account for the `zoneLocations` query after the zone query, and the expected channel lists gain the zone's agronomy entries (spec decision: the new kinds are always built, not only when their dependencies are injected);
- a zone with coordinates, a `weather_locations` row, hours, one assigned S2120 with station hours and agronomy rows lists the provider (six channels), station (seven) and agronomy (two) entries with the exact `sourceKey`, `deviceName` and `sourceKind` values above, in the stated order;
- a zone with `weather_source = 'local'` has no provider entry; a zone whose location row is missing has none either;
- two zones sharing a location get two entries with different `seriesId`s and identical points;
- device entries and their `seriesId`s are identical to the pre-change catalogue for the same fixture, and no device source lists a key of `DEVICE_EXCLUDED_CHANNELS`;
- provider series at `raw` (rows as points, `t` = `hour_start` in `.000Z` form for rain, `hour_start + 1 h` for an Open-Meteo temperature, `hour_start` for a MeteoSwiss temperature), `hourly`, `daily` (rain and ET0 are sums over Europe/Zurich local days, temperature the mean) and `weekly`;
- series units: provider rain is `mm/h` at `hourly`, `mm/d` at `daily`, `mm/wk` at `weekly`; the S2120's device rain in the same response keeps `mm/h`; `cadence` is `'daily'` for provider rain at `daily` and for the agronomy series, `'hourly'` for device series;
- a daily provider sum with one missing hour has `count: 23`, `expected: 24`, `quality: 'partial'`; a weekly agronomy sum with one null day has `count: 6`, `expected: 7`, `quality: 'partial'`; the first daily bucket of a range starting at 06:00 local is partial;
- station hours with a five-hour hole at `raw` give one inserted null point in the hole; station rain summed, pressure averaged;
- daily agronomy: points at local midnight in Europe/Zurich across the 2026-10-25 transition; a null `et0_mm` gives `{ value: null, count: 0 }`; a missing date gives an inserted null point;
- scoped mode (`zoneUuids`) lists weather entries only for the listed zones; legacy mode filters the station by owner;
- the 30 000-row cap counts provider, station and device rows together and answers `413`;
- a `zoneLocations` that throws makes `buildAnalysisCatalog` reject with that error.

`scripts/test-zone-weather-source.js` (new, run in `.github/workflows/verify-sync-flow.yml`; spec decision). It runs the shipped nodes through `executeFunction` and `loadNode` from `scripts/lib/scoped-access-harness.js`, as `scripts/test-legacy-upsert-zone-name.js` does, and drives the triggers on copies of the bundled databases, as `scripts/test-zone-update-sync-version.js` does (copy the file to a temp dir, insert a linked `sync_link_state` row, a user and a zone, clear `sync_outbox`, update):
- `zone-config-fn` stores a valid value, lower-cases `MeteoSwiss`, stores `'auto'` for `null`, answers `400` for `open-meteo!` and for 21 characters, bumps `sync_version`, and returns `weather_source` and `weather_source_default`;
- `get-zones-query` / `get-zones-response` return the stored value, and `weather_source_default` is `meteoswiss` with `OSI_WEATHER_PROVIDER_DEFAULT=meteoswiss`, `open_meteo` when unset or `bogus`;
- "Build UPDATE SQL": `UPSERT_ZONE_CONFIG` with `weatherSource` and with `weather_source`; `null` stores `'auto'`; an invalid value leaves the column and warns; legacy `UPSERT_ZONE` inserts `'auto'` when absent and keeps the stored value on conflict when absent;
- 0063 on each of the seven bundled DBs: a linked gateway changing only `weather_source` gets one `ZONE_CONFIG_UPSERTED` row whose payload carries the new value; a change of the name carries the unchanged `weather_source` too; an unlinked one gets none; an update that changes nothing gets none.

`scripts/test-zone-command-path.js`: the flip and the new rejection above, plus an `UPSERT_ZONE` update without the field that keeps a stored `meteoswiss`.

`scripts/test-scoped-access-reads.js`: the viewer catalogue case gains a location row and asserts the provider entry for both zones.

`scripts/test-terra-selection-edge-acceptance.js`: passes against the regenerated fixture.

`verify-sync-flow.js` pins cover the snapshots and the capability (no separate test).

GUI (`npm run test:unit`):
- `ZoneConfigModal.test.tsx`: the four options render and the auto option reads "Gateway default (MeteoSwiss)" for `weatherSourceDefault: 'meteoswiss'`; choosing MeteoSwiss sends `{ weatherSource: 'meteoswiss' }`; an unchanged selection sends no `weatherSource`; a stored `openagri` shows as a disabled selected option and a save of the crop does not send `weatherSource`; the field sits after the Device GPS panel;
- `AnalysisSeriesTray.test.tsx`: an entry with `deviceName: 'North daily agronomy'` and `displayName: 'North daily agronomy - Crop water demand (ETc)'` renders the button text `Crop water demand (ETc)`; a catalogue with a provider entry shows an `Open-Meteo 46.80°N 6.95°E` group under its zone, after the zone's device groups;
- `CrossZoneAnalysisPage.test.tsx` and `MetricAcrossZonesPicker.test.tsx`: with two zones sharing a location, the temperature preset selects the device series only, and no button appears for `et0_mm`;
- `echartsOptions.test.ts`: a `cadence: 'daily'` series has `showSymbol: true`; a partial point's tooltip text ends with "(23 of 24 h)";
- `unitGrouping.test.ts`: `mm/d` and `mm/h` series form two panels;
- `channelLabels.test.ts`: the axis label for `et0_mm` uses "Reference evapotranspiration" and the series unit;
- `csv.test.ts`: a provider series exports with its `source_key` and `channel_key`; a daily-cadence series in Europe/Zurich exports `2026-09-25` for `t = 2026-09-24T22:00:00.000Z` and unit `mm/d`;
- `tests/zoneFormLocales.test.ts`: the eight keys in seven locales, placeholders matching (`{{provider}}`, `{{value}}`), reviewed identical pairs listed;
- `tests/analysis-locales.test.ts`: the four new `analysis.*` keys in every locale.

## Acceptance

Run after the merge order of the RAK branch and the three weather branches is settled, and after the sub-project 4 cloud change is live on the cloud each gateway links to ("Ownership and deploy order"). Gateways: the demo gateway (S2120 assigned, internet, cloud-linked) and the MeteoSwiss-default test gateway (linked), deployed with `deploy.sh` per the live-ops runbook; the live database is never replaced. Replace `<zone>`, `<key>`, `<deveui>`, `<offset>` with the gateway's values; `<offset>` is the zone's UTC offset in the test window, `'+2 hours'` for Europe/Zurich before 2026-10-25 and `'+1 hour'` after.

The chart shows times in the browser's timezone and the database stores UTC: `hour_start = 12:00:00Z` appears as 14:00 in the tooltip in CEST, and a daily point sits at local midnight (00:00) when the browser and the zone share a timezone.

0. Before deploying, save a view `device-baseline` with one soil series and one S2120 device series on the 7-day range, and note three values from each.
1. The Data tab lists under each located zone an `Open-Meteo …` (the demo gateway) or `MeteoSwiss …` (the MeteoSwiss-default test gateway) group with six channels, and a `<zone name> daily agronomy` group with two. Every tray button of these groups shows its channel name, not the source name.
2. Provider sums per local day: pick the 30-day range (auto chooses daily buckets above 8 days; a 7-day range gives hourly points), select the provider's rain and ET0 channels, and save the view as `weather-acceptance`. The tooltips of the last seven complete days equal, within 0.1,
   `SELECT date(hour_start, '<offset>') AS day, ROUND(SUM(rain_mm), 3), ROUND(SUM(et0_mm), 3), COUNT(*) FROM weather_provider_hours WHERE location_key = '<key>' AND hour_start >= date('now', '-9 days') GROUP BY day ORDER BY day;`
   ET0 is never zero over a day, so a dry week still tests the sum. A day with `COUNT(*)` below 24 shows "(n of 24 h)" in its tooltip; today's point always does. The rain and ET0 panels read `mm/d`.
3. ET0 against the daily record: for days with `et0_tier = 'provider_hourly_sum'` the provider ET0 daily points equal, within 0.01 (the writer rounds to two decimals and clamps at zero),
   `SELECT date, et0_mm FROM zone_daily_agronomy WHERE zone_id = <zone> AND et0_tier = 'provider_hourly_sum' ORDER BY date DESC LIMIT 7;`
   Compare through the CSV export, not the chart tooltip (`tooltipValueFormatter` prints one decimal, which cannot resolve 0.01). On the demo gateway, where the station tier may win every day, record N/A if the query returns no row.
4. Station source on the demo gateway: a `<station name> (hourly)` group appears for the zone with the S2120; on the 24-hour range the last three temperature points equal
   `SELECT hour_start, ROUND(air_temperature_c, 1) FROM weather_station_hours WHERE deveui = '<deveui>' ORDER BY hour_start DESC LIMIT 3;`
   and on the 30-day range the station's rain per day equals `SELECT date(hour_start, '<offset>') AS day, ROUND(SUM(rain_mm), 3) FROM weather_station_hours WHERE deveui = '<deveui>' AND hour_start >= date('now', '-9 days') GROUP BY day ORDER BY day;` within 0.1.
5. Daily agronomy: on the 30-day range the `et0_mm` and `etc_mm` points equal
   `SELECT date, et0_mm, etc_mm, et0_source, null_reason FROM zone_daily_agronomy WHERE zone_id = <zone> ORDER BY date DESC LIMIT 7;`
   Find a null day with `SELECT date FROM zone_daily_agronomy WHERE zone_id = <zone> AND et0_mm IS NULL ORDER BY date DESC LIMIT 1;`, set a custom range around it, and check that it shows as a gap and that a valid day between two null days shows as a dot; record N/A if no null day exists. Export the CSV: the agronomy rows carry dates `YYYY-MM-DD` and unit `mm/d`.
6. Provider change: open zone settings; the auto option reads "Gateway default (MeteoSwiss)" on the MeteoSwiss-default test gateway and "Gateway default (Open-Meteo)" on the demo gateway unless its UCI default differs. Set the zone to the other provider and save. Then
   `SELECT weather_source, sync_version FROM irrigation_zones WHERE id = <zone>;` shows the new value, and
   `SELECT op, json_extract(payload_json, '$.weather_source'), sync_version, delivered_at FROM sync_outbox WHERE aggregate_type = 'ZONE' AND aggregate_key = (SELECT zone_uuid FROM irrigation_zones WHERE id = <zone>) ORDER BY rowid DESC LIMIT 2;` shows exactly one new `ZONE_CONFIG_UPSERTED` row with that value. Reopen zone settings: the selector shows the chosen provider. Save a change to Notes only: the stored `weather_source` is unchanged and the new outbox row carries the same value. After the next weather tick (at most 30 minutes)
   `SELECT location_key, station_id, last_success_at, last_error FROM weather_locations ORDER BY created_at DESC LIMIT 3;` lists a row for the chosen provider. Reload the Data tab: the provider group carries the new name, either `MeteoSwiss <station> (<n> km)` or, outside coverage, `MeteoSwiss <lat>°N <lon>°E` with no points and `last_error` = `outside MeteoSwiss coverage`. Do not set the zone back yet — step 7 needs it still on the changed provider, since the new `locationKey` (and `sourceKey = sha256(locationKey)`) only exists while the zone stays there; setting it back first makes step 7 vacuous.
7. While the zone is still on the changed provider, open `weather-acceptance`: it reports the dropped provider series from before the change and keeps the rest. Then set the zone back to its original provider.
8. Open `device-baseline`: no dropped notice, and the noted values are unchanged.

## Not in scope

- The zone CSV endpoint `/api/history/zones/:id/export.csv` (reads `device_data` only; a follow-up if a user asks for provider weather in that file).
- The `environment-variables` history-card overlay (declared in `history/overlayPolicy.ts` line 11, never implemented, not among Phil's five items).
- Any cloud data view.
- Retention of the weather tables (`docs/operations/edge-history-retention.md` stays as sub-project 2 left it).
- Storing Open-Meteo's instantaneous values at their own instant in `weather_provider_hours` (the data view offsets them instead).
- Step-shaped lines for period totals; the per-period unit and the badge's HelpTip carry the meaning (spec decision).
- The Weather tab and Water tab (the forecast chart stays on its live path).
- A per-station wind height, a second station type, and a timezone-aware daily bucket for device series.

## Review changes

Committee of 2026-09-27: chair (fable), data and sync-contract member, product design member; controller rulings in the git-ignored SDD workspace.

**Chair**
- F1 (bootstrap and force-sync snapshots): both snapshot builders carry `weather_source`, with pins and allowances ("Snapshots and capability"); decision 35 removed from "Not in scope".
- F2 (capability): the edge advertises `zone_config_weather_source_v1` in the three nodes that build `syncCapabilities`; the cloud sends the field only to gateways that report it.
- F3 (zone-timezone days): the hourly kinds pass `timezone` to `aggregateRows`; `timezone` is stored for every kind; acceptance uses local-day SQL.
- F4 (same-named osi-server branch): "Landing requirements" lists the pushed branch's five changes, including the vendored `resources.schema.json`, and the lockstep merge.
- Minors: legacy `UPSERT_ZONE_CONFIG` maps `null` to `'auto'` (M1); `AdvancedScheduleDrawer` exclusion stated (M2); rollback line in the migration section (M3); partial sums defined (M4); isolated hourly points stated (M5); `weatherProviderDefault` is test-only (M6); the Luganda obligation stated (M7); `channel-manifest.md` SHA is documentation only (M8).
- The twelve interfaces: `SOURCE_KINDS` shape, `createAnalysis` deps and where the default is resolved, the `weather_locations` and station SELECTs, `entriesById` fields and the group key, `aggToPoints(aggregate, channelKey, { stat, expected })` and `rowsToPoints`, shared `LIMIT remaining + 1`, error propagation when `zoneLocations` throws, the test harness, the GUI types and state variable, the capability string and its three nodes, and the two `zone-config-fn` SELECTs are all defined above.

**Data and sync**
- B1 (ownership): the edge owns `weather_source` after sub-project 4 and emits it in every zone update payload and both snapshots; the deploy-order constraint and its cost are in "Ownership and deploy order"; "nothing breaks" is gone.
- I1 (capability): as chair F2.
- I2 (snapshots): as chair F1.
- I3 (vendored contract): on the same-named osi-server branch; lockstep merge.
- I4 (Terra fixture): regenerated with its `.sha256`; `test-terra-selection-edge-acceptance.js` listed as a gate.
- I5 (ledger test): `reconcile-ledger-numbering.test.js` extended through 63 and listed as a gate; its existing red is named.
- I6 (preset): device entries only.
- I7 (partial sums): `count`, `expected` and `quality: 'partial'`, the tooltip "n of N h", and the two named tests.
- I8 (red tests): `index.test.js` line 259 and the catalogue tests at `analysis.test.js` lines 59–187 are named in "Testing".
- Minors: `localDateKey` injected (M1); `to` rounded up (M2); a single daily point shows as a dot (M3); `coverageConfidence` not used for the new kinds (M4); legacy path warns only on invalid strings (M5); acceptance tolerance 0.1 (M6); 0063 byte-identical to the canonical text and `lib/osi-migrate/__tests__` named (M7); AGENTS.md note (M8); `auto` defined on both sides (M9); station owner is the raw `devices.deveui` (M10); `osi-journal/context.js` listed among the `sum` consumers (M11).

**Product design**
- B1 (tray label): `channelLabel` strips `${deviceName} - `; tray test added.
- B2 (period unit): summed series units name the period; unit test added.
- I1 (provider HelpTip): the reviewer's four sentences, corrected so that a station's FAO-56 ET0 takes precedence, `local` stops history downloads but not the forecast, and MeteoSwiss covers Switzerland.
- I2 (hourly and daily ET0 on one axis): separated by the period unit; the badge HelpTip explains point times; step-shaped lines not adopted (spec decision, simpler).
- I3 (bridged gaps): null points inserted where rows are more than one native step apart.
- I4 (invisible single day): daily-cadence series draw symbols.
- I5 (partial first and last sums): kept and marked partial; acceptance compares complete days.
- I6 (Open-Meteo one hour early): the +1 h plot offset.
- I7 (preset duplicates and labels): device entries only, so labels and 25-series limits stay as today.
- I8 (selector placement): after the Device GPS panel, before the divider above Notes.
- I9 (acceptance): ET0 check, saved views created and reopened, device baseline, provider reads back, Notes-only save, reload, MeteoSwiss coverage outcome, tray labels, local-time note, 30-day range with local-day SQL.
- I10 (CSV): "Analysis page (GUI)" states timestamp, unit, value and null rows.
- Q1: period units, as ruled.
- Q2: `cadence` and `timezone` on each series; zone-local date in the CSV for daily cadence.
- Q3: one HelpTip beside the aggregation badge.
- Q4: "Gateway default (<provider>)" from `weather_source_default` on the zones list, fallback `open_meteo`.
- Q5: Open-Meteo instantaneous channels at `hour_start + 1 h`; storage unchanged, follow-up noted.

**Plan review** (2026-09-27: GUI, chair and edge members; the plan answers each finding)
- Base: the branch is stacked on `feat/daily-agronomy` @ `8531f1dd1`, which carries the ledger-test extension and the `osi-agronomy-daily` frozen-snapshot fix; no rebase, no known red.
- Insert trigger: 0046 stays as it is; "every zone payload" now reads "every zone update payload and both snapshots" in "Decisions", "Ownership and deploy order" and the migration section.
- Aggregation help: names daily agronomy as the tray does, and the point time per level (raw at the reading's time, the other levels at the start of the period); model output is called values, not readings.
- Card channel lists: the edge and cloud GUI registries leave out a manifest channel with neither an edge nor a server column, so the three weather keys never reach an export dialog (plan Tasks 1 and 10).
- Tooltip: the analysis chart's formatter replaces the ECharts default for every series and copies its layout; the stacked layout has its own test.
- Tray: each source group is a named group (`role="group"`, `aria-labelledby`) for screen readers.
