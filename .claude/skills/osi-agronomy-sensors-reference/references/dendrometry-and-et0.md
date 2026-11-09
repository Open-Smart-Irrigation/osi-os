# Dendrometry and ET0

Part of the osi-agronomy-sensors-reference skill; read SKILL.md first.

## Dendrometry

**What it measures:** an LSN50 with a point dendrometer measures micrometer-scale
stem/trunk radius change. Edge storage: `device_data.dendro_position_mm`
(mm) is the live/latest value; `dendrometer_readings` is the append-only
history table with `position_um` (µm, `NOT NULL`), `position_raw_um`,
`adc_v`/`adc_ch0v`/`adc_ch1v`, `dendro_ratio`, `dendro_mode_used`, `is_valid`,
`invalid_reason`, `is_outlier`, `dendro_saturated`/`dendro_saturation_side`,
and `recorded_at` — verified against `database/seed-blank.sql` (`CREATE TABLE
dendrometer_readings`).

**MDS (maximum daily shrinkage), as implemented (edge, v5):** the day's
maximum stem position minus its minimum (`d_max_um - d_min_um`), stored as
`dendrometer_daily.mds_um`. Computed in `flows.json` node id
`dendro-compute-fn` ("Daily Dendrometer Analytics"), which the node's own
header comment labels "Dendrometer Analytics v5 (envelope-based TWD, absolute
thresholds)". This v5 edge computation also derives `d_max_um`, `d_min_um`,
`tgr_um` (trunk growth rate), `twd_um`, `dr_um` (daily recovery), and a
`stress_level` classified against **absolute-µm** per-crop thresholds
(`CALIBRATIONS` map keyed by crop, e.g. `apple`, `grapevine`, `olive`,
`default`) — not the self-calibrating model described next.

**TWD (tree water deficit)** — two distinct implementations, different
ownership, do not conflate them:
- **Edge (v5, shipped, this repo):** `twd_um`, an absolute stepwise "envelope"
  deficit in micrometers, computed daily by `dendro-compute-fn` in
  `flows.json` and stored in `dendrometer_daily`. This is what powers the
  on-device DENDRO scheduler trigger and the edge dashboard today.
- **Cloud (v6, shipped, osi-server-only):** `TWD_rel = TWD_day / A_ref`, a
  dimensionless ratio against a self-calibrated well-watered baseline
  amplitude (`A_ref`, ~14 good days to establish). This is **cloud-only** —
  it runs server-side (`DendroScheduler`/`DendroController` in osi-server) and
  is persisted in the cloud's recommendation payload, but it is **not
  surfaced in the edge dashboard and does not drive the edge DENDRO
  scheduler**; the edge keeps running its own v5 absolute-µm classifier.
  Reference: `docs/architecture/dendrometer-analytics-v6.md` (status:
  "Implemented (osi-server). ... the edge UI is not yet a consumer" — see its
  own "Boundaries" section). Until a tree has an edge-computed v5 baseline,
  edge classification behavior is unchanged from v5 regardless of what the
  cloud does.

**Dendrometer controller — draft only:**
The private controller design begins "**Status:** Draft design, not shipped
behavior." It describes a future opt-in
`controller_mode='dendrometer'` architecture that would compare against
the partner institute's `Tree_HSMM`/`Tree_irrigator` reference logic. Treat it purely as
a design reference, not current runtime behavior, and do not cite it as if
MDS/TWD already work this way.

## ET0 (reference evapotranspiration)

**The edge computes ET0, as of the daily agronomy record (2026-09-26).**
`osi-agronomy-daily` (`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily`)
writes one row per zone per completed local day into `zone_daily_agronomy`,
resolving ET0 through three tiers, the first complete one winning for that
day:
1. **`station_fao56`** — hourly FAO-56 Penman-Monteith (eq. 53), summed
   over the local day: `resolveDay` calls `et0.js`'s `fao56Et0HourlyDay`,
   and the row stores `et0_tier` `station_fao56` with `et0_source`
   `fao56_hourly`. The input is a SenseCAP S2120 assigned to the zone
   (`weather_station_zones`), whose uplinks `osi-station-hours` aggregates
   into `weather_station_hours` (radiation from `light_lux / luxPerWm2`).
   Every hour of the local day (23 or 25 across a DST change) needs mean
   temperature, humidity, wind and non-negative radiation from at least
   three uplinks; this tier does not use daily minimum or maximum
   temperature. The zone also needs a longitude, which hourly Ra requires.
   The signed hourly values are summed, clamped at 0 once and rounded to 2
   decimals. A day whose radiation sum is 0, or strictly below 0.06 × Ra, or
   that reads 0 in an hour whose extraterrestrial radiation exceeds
   1 MJ/m², falls to the next tier (covered or failing light sensor). The
   daily `fao56Et0` helper remains in `et0.js`, but `resolveDay` does not
   call it.
2. **`<provider>_hourly_sum`** — the sum of the zone's stored
   `weather_provider_hours` (Open-Meteo or MeteoSwiss, fetched by
   `osi-weather-provider`) over the local day, only when every hour is
   present.
3. **`hargreaves_station`** — Hargreaves-Samani (`et0.js`'s
   `hargreavesEt0`) from the station's own daily minimum and maximum
   temperature, needing no radiation or humidity.

A day with none of the three complete gets a null `et0_mm` and a stated
`null_reason` (`no_source`, `partial_day`, `mixed_station`,
`unknown_station`, `pending` or `no_location`), never a scaled or guessed
value. The crop coefficient (Kc) and the FAO-56 growth-stage vocabulary come
from `osi-crop-kc`, reading the shared catalogue in
`docs/contracts/agronomy/` (`crop-kc.json`, `kc-vectors.json`,
`et0-vectors.json`; every copy checked byte-identical by
`scripts/verify-agronomy-contract.js`). The cloud adopts the same catalogue
and tiers in a later sub-project; until then a linked gateway's Water tab
may still show the drift banner for a zone whose crop or stage the cloud
does not yet resolve the same way.
