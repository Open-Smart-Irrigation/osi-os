# Piece 3 — Weather Pipeline (MeteoSwiss OGD, VPD, Rain/Forecast)

Part of the [Agroscope Irrigation Logic — Integration Assessment](00-overview.md).

## 1. What it is / how it works

Scope: MeteoSwiss Open Government Data (OGD) "local-forecasting" STAC API → local SQLite
`EnvironmentalData`.

**Fetch.** One STAC API `GET` lists items; the code picks the day-slot `"YYYYMMDD-ch"` and tries
the three most recent hourly slots (now / -1h / -2h) (`get_weather.py:53-83`). For each slot it
downloads four nationwide parameter CSVs — temperature `tre200h0`, radiation `gre000h0`, wind
`fu3010h0`, precipitation `rre150h0` — and filters each to the area's `point_id`. The acceptance
rule is **all-or-nothing**: all four parameters must be present or the code moves to the next
slot, eventually returning `None` (`get_weather.py:86-122`).

**Derive & persist.** The four series are combined, the index is localized to Europe/Zurich, VPD
is derived in-pipeline, and each row is flagged `measured = (index <= now(Zurich))`
(`get_weather.py:125-154`). Each row is persisted individually to `EnvironmentalData` with a
UTC-naive timestamp, `station_id`, `measured` flag, temperature, rain, and VPD.

**The key semantic subtlety.** `measured` is not provenance — every row, forecast or "measured,"
comes from the same forecast product. No true observation dataset is ever fetched. `measured`
really means "this hour has elapsed and will not be revised," i.e. **finalized vs. revisable**,
not observed vs. predicted.

**Reconciliation state machine** (`get_weather.py:217-249`), keyed by `(station_id, UTC
timestamp)`:

| Existing row | New row | Action |
|---|---|---|
| absent | any | insert |
| stored forecast | new measured | update_to_measured |
| stored forecast | new forecast | update_forecast (latest wins) |
| stored measured | new measured | skip_duplicate (first write wins; measured is immutable) |
| stored measured | new forecast | skip_keep_measured (never downgraded) |

The dispatcher maps these five actions 1:1 to writes (`main.py:1757-1779`). Note: the
reconciliation function ignores its own temperature/VPD/rain arguments — the decision is purely
flag-based (`get_weather.py:217-249`) — and measured rows are never updated even by newer measured
data.

**Station selection.** Nearest local-forecasting point by Euclidean lat/lon distance over a
bundled 5,630-row CSV (`get_closest_station`, `get_weather.py:15-44`); areas missing a station are
auto-assigned (`update_missing_weather_stations`), and the assignment is permanent — only `NULL`
station_ids are ever set.

**Consumption (definitive).** VPD is never used in control: it is computed at ingest, stored, and
consumed only by the GUI chart/CSV/template (`GUI/GUI.py:940`, `GUI/main.py:3111,3167-3175`).
Temperature is likewise store-and-display only. The controller's **only** weather input is
forecast rain, through one consumer, `_get_forecast_rain_sum_for_area_day`
(`main.py:146-163`): a raw SQL `SUM(COALESCE(rain,0)) WHERE station_id AND date(timestamp)=day AND
COALESCE(measured,0)=0` — i.e. forecast-only rows. This is called from the PID loop
(`main.py:295-315`): if `forecast_rain_mm > PID_FORECAST_RAIN_SKIP_MM` (default 2.0 mm), the day's
irrigation is forced to 0 and the PID cycle is parked without an update. The physical rain-sensor
path is separate (`sensors_processing.py` → `precipitation_measured_mm`).
`precipitation_meteoswiss_mm` (`models.py:123`) is a dead column — a write hook exists
(`main.py:1455-1456`) but nothing ever produces it.

**Sharpest finding — a data-contract violation at the single consumer.**
`_get_forecast_rain_sum_for_area_day` reads the `measured=0` (forecast) class, but the ingester
systematically drains that class: every hourly run upgrades elapsed hours to measured
(`get_weather.py:236-238`), and cleanup deletes forecast rows older than 7 days
(`get_weather.py:297-317`). Consequences:

1. The 03:00 PID run for the last-closed day mostly reads hours that have already been upgraded to
   measured and are therefore **excluded** from the sum — whether the rain-skip fires depends on
   how many overnight upgrade passes happened to succeed, not on actual weather.
2. Manual PID replay over historical days always sees `forecast_rain=0` (rows deleted or upgraded
   by then) — replay is not reproducible against the live run.
3. `date(timestamp)` buckets on a UTC-naive column while `day_date` is a local day, producing a
   1–2 hour boundary skew.

Either agronomic intent — "rain that already fell yesterday" vs. "rain still coming" — is broken
by the mutation/retention policy, depending on which was intended.

## 2. Strengths

- **Reconciliation state machine.** Five explicit named outcomes, a monotone
  measured-beats-forecast lattice, idempotent and keyed per station/timestamp, with stats logged —
  the portable core of this piece.
- **Multi-slot fallback with all-or-nothing acceptance.** Per-slot reset plus the 4-parameter
  all-or-nothing rule means no partial rows ever reach the database.
- **Self-healing coverage.** Each fetch spans past and future, so a failed hour is backfilled on
  the next run.
- **Consistent UTC-naive storage** at the persistence layer.
- **Per-row exception containment** in the write loop.

## 3. Weaknesses & risks (ranked)

1. **The forecast-rain drain bug** (`get_weather.py:217-249,236-238,297-317`; consumer
   `main.py:146-163`). The only weather signal the controller uses is silently starved by the
   ingester's own upgrade-to-measured and 7-day-retention behavior — see Section 1's "sharpest
   finding." This breaks both the daily rain-skip gate and the reproducibility of historical PID
   replay.
2. **O(stations) network amplification.** `get_local_forecast` runs per station, and each call
   re-downloads the STAC list and all four **nationwide** CSVs before filtering to one point
   (`get_weather.py:89-92`, `main.py:1722-1724`) — K stations means K identical multi-megabyte
   downloads per run.
3. **O(rows) DB round-trips.** Two round-trips plus one `COMMIT` plus one app-context re-entry per
   row (`get_weather.py:228-231,270,284-287,295`).
4. **Failure gaps.**
   - `check_and_update_weather_data` sits **outside** the per-row `try` (`main.py:1753` vs.
     `1755`), so a DB error aborts all remaining rows, remaining stations, and cleanup for that
     run.
   - Param-missing and download-fail both `break` silently — the warning is commented out
     (`get_weather.py:99-103`).
   - A permanently-wrong `station_id` (its `point_id` absent from the CSV, `tmp.empty`) is
     indistinguishable from a transient outage and fails identically every hour, forever.
   - No request timeout on any `GET`; weather runs first in the pipeline, so a hung endpoint stalls
     the entire tick.
5. **Euclidean lat/lon "nearest station."** No `cos(lat)` correction (`get_weather.py:26-29`)
   inflates east-west distance; separately, `area.latitude and area.longitude` truthiness drops
   valid `0.0` coordinates.
6. **Five clock conventions in one path.** UTC-naive storage, a Zurich-aware `measured` flag, a
   UTC-date rain bucket, a Zurich-aware daily gate, and a naive `datetime.now()` cleanup cutoff
   (`get_weather.py:301`) — all coexisting.
7. **Dead code / drift.** A "check for data gaps" loop computes `last_data` and never uses it
   (`main.py:1714-1720`); the docstring promises an ET0 computation that never happens;
   `EnvironmentalData` is defined twice — once canonically (`models.py:61-68`) and once as an
   independently drifting copy (`GUI/GUI.py:180-188`).
8. **Stale-forecast inflation.** Forecast rows for elapsed hours whose upgrade-to-measured pass
   failed are still counted as forecast rain by the PID gate, which can spuriously inflate the
   skip condition.

## 4. Integration challenges (OSI OS / OSI Server)

- **[P3] MeteoSwiss/CH-only source is the top blocker.** The entire pipeline — STAC endpoint,
  `"YYYYMMDD-ch"` slot IDs, the four MeteoSwiss parameter codes, the bundled Swiss
  forecasting-point CSV, Europe/Zurich hardcoded in three places — is Switzerland-specific. OSI
  runs at least one non-Swiss site (Uganda), where MeteoSwiss has no coverage; OSI's own
  `agroscope-dendrometer-controller.md` draft already rejects dendrometer mode outside MeteoSwiss
  coverage for this reason. A non-Swiss location fed into Agroscope's nearest-point search would
  silently be assigned the nearest Swiss border point and "work" — a latent correctness trap, not
  just a coverage gap.
- **[P3] Required: a provider abstraction.** OSI must implement the interface the source material
  itself recommends — `fetch(station, window) -> [(ts_utc, values, finalized)]` — backed by OSI's
  own sources: the on-site SenseCAP S2120 weather station (real measured rain/temperature/humidity)
  and/or a global forecast API for the predictive side. This is a genuine build, not a port.
- **[P3] The reconciliation state machine becomes *more* correct on OSI.** Agroscope's `measured`
  flag is a finality flag because it only ever has one (forecast) data source. OSI actually has a
  true measured source (S2120) alongside a forecast feed, so porting the five-action
  reconciliation lattice onto OSI lets `measured` regain its literal meaning — a case where the
  target platform is a better fit for the source logic than the system it was built in.
- **[P3] The integration surface is small and well-defined.** The controller consumes exactly one
  weather quantity: forecast rain (mm) for local day D, per zone/station. The port does not need
  the whole MeteoSwiss pipeline — only a query of that shape, backed by whatever provider(s) OSI
  wires in.
- **[P3] Design out the drain bug from day one.** Query rain over **all** rows for the target day
  (or a snapshot taken at decision time), never the mutable forecast-only (`measured=0`) class.
  Bucket by the zone's **local** day, not UTC, to avoid the boundary skew described in Section 1.
- **[P3] Clock discipline.** OSI already standardizes on UTC storage plus per-zone timezones (v6
  SolarWindows). Keep a single clock convention through the weather port; do not inherit
  Agroscope's five-clock path (Section 3, item 6).

## 5. OSI v6 improvement ideas

- **[P3] Adopt the measured-beats-forecast reconciliation discipline.** Measured immutable,
  forecast revisable, measured never downgraded by a later forecast — this is a cleaner discipline
  than v6's current rain suppression window, and (per Section 4) becomes fully correct once OSI
  supplies a real measured source (S2120) alongside a forecast feed.
- **[P3] Open design/experimental question — VPD's role.** Agroscope computes VPD but drops it
  from control entirely (rain + stress only), whereas OSI v6 applies a VPD-based stress adjustment.
  This is a genuine divergence worth flagging for the parallel comparison, not a settled claim: the
  side-by-side run is an opportunity to test empirically whether v6's VPD adjustment adds signal or
  adds noise relative to Agroscope's rain-only approach.

## 6. Re-implementation complexity

**Rating: LOW-MEDIUM.**

The real logic is small — roughly 320 lines in `get_weather.py` plus ~130 lines of orchestration,
a single-table sink, and a compact, clean state machine. Two things make this harder than the line
count suggests:

1. **No existing provider abstraction.** Fetch, parse, station metadata, VPD derivation, timezone
   handling, and the measured-rule are all fused together inside `get_local_forecast`. A port must
   first extract the interface `fetch(station, window) -> [(ts_utc, values, finalized)]` before any
   MeteoSwiss-specific code can be replaced with an S2120/forecast-API-backed implementation.
2. **Clock/semantics decisions must be resolved before porting, not during.** The consumer-contract
   race identified in Section 1 — upgrade-to-measured passes vs. the single daily weather read vs.
   7-day forecast deletion vs. historical replay — has to be designed out up front (query all rows
   for the target day, bucket by local day) or the port inherits the drain bug verbatim.

**Minimal weather contract the controller actually needs:** one field, `rain` (mm per hour-bucket),
per area-resolvable station, hourly, carrying a measured/forecast (finalized/revisable) flag,
queryable as "sum of rain for local day D in state X." Temperature and VPD are display-tier only
and can be added later without touching the control path.

**Genuinely reusable as-is:** the reconciliation state machine and action→write dispatcher with
stats (`get_weather.py:217-249`, `main.py:1752-1792`) — provider-agnostic, and arguably more
correct on OSI than in its native codebase (Section 4). Also reusable: the dual-write contract
(one table: station_id, UTC timestamp, measured flag, values, measured-monotone), the multi-slot
retry with all-or-nothing param acceptance, and the 7-day forecast-only retention policy
(paired with "keep measured forever") — provided the retention policy is applied only after the
drain-bug fix above.
