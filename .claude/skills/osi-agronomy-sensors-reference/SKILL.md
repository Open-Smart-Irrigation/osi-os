---
name: osi-agronomy-sensors-reference
description: Use when interpreting soil water tension (SWT) kPa or pF values, Chameleon sensor calibration/wiring, dendrometer TWD/MDS output, rain gauge aggregation (LoRain/S2120), ET0/evapotranspiration questions, deciding which device_data column a sensor writes to, STREGA valve command semantics, STREGA Gen1 vs Gen2 (SV2) telemetry differences and enclosure temperature/humidity, UC512 valve telemetry, or any device-payload/decoder question. Covers KIWI_SENSOR, TEKTELIC_CLOVER, DRAGINO_LSN50, SENSECAP_S2120, AQUASCOPE_LORAIN, STREGA_VALVE, MILESIGHT_UC512.
---

# OSI Agronomy & Sensors Reference

## Overview

This skill is the domain model for how OSI OS represents soil, plant-water, and
weather measurements in the database, the scheduler, and the dashboard. It
answers "what does this number mean and where does it live", not general
agronomy theory. Claims are tied to the code or docs named next to them; when
using this skill for implementation, re-check drift-prone facts in the current
branch before treating them as completion evidence.

## When to use / When NOT to use

Use this skill when you need to:
- Interpret a stored SWT/kPa/pF value, or decide whether a number is "wet" or "dry".
- Understand Chameleon resistance-to-kPa calibration or the array_id lookup flow.
- Explain dendrometer MDS/TWD/TWD_rel output or find which side (edge vs cloud) computes it.
- Explain rain aggregation semantics for LoRain or S2120, or a "missing vs zero" rain question.
- Determine which `device_data` column a given sensor/device type populates.
- Explain STREGA valve command semantics (`OPEN_FOR_DURATION`, cancel).
- Answer whether a given STREGA generation reports temperature or humidity.
- Explain LoRaWAN join/uplink vocabulary (OTAA, FPort, DevEUI...) as used by this system.

Do NOT use this skill for (route instead):
- Debugging a symptom like `i2c_missing=1`, a data gap, or a stuck sync — **osi-debugging-playbook**.
- Deploying to or repairing a live Pi, backups, restart procedures — **osi-live-ops-runbook**.
- Mechanically editing `flows.json` (node shapes, wiring function nodes) — **osi-flows-json-editing**.
- Adding/altering a table, column, or migration — **osi-schema-change-control**.
- `CHIRPSTACK_PROFILE_*` env vars, device-profile provisioning, feature flags — **osi-config-and-flags**.
- Pure layout, spacing, copy, or styling changes that do not alter sensor
  semantics, units, decoder fields, thresholds, or displayed measurement meaning.

## Device catalog and units quick-reference

| Device | ChirpStack app | Custom OSI decoder? | Primary `device_data` fields | Units |
|---|---|---|---|---|
| `KIWI_SENSOR` | Sensors | Vendor — `tektelic_agriculture_decoder.js` (upstream TEKTELIC agriculture codec, shared with CLOVER; a codec attached by hand is kept) | `swt_1`, `swt_2` (via legacy `swt_wm1/2` aliasing), `light_lux`, `ambient_temperature`, `relative_humidity` | kPa, lux, °C, %RH |
| `TEKTELIC_CLOVER` | Sensors | Vendor — `tektelic_agriculture_decoder.js` (upstream TEKTELIC agriculture codec, shared with KIWI) | same shape as KIWI; VWC is **typed but not populated** (see VWC note below) | °C, %RH; VWC not stored |
| `DRAGINO_LSN50` | Sensors | Yes — `dragino_lsn50_decoder.js` | `ext_temperature_c` (DS18B20), `adc_ch0v/adc_ch1v`, `bat_v`, plus MOD-specific: `dendro_position_mm`/`dendro_*` (dendrometer), `rain_*` (rain gauge), `flow_*` (flow meter), and Chameleon `swt_1/2/3` when a VIA Chameleon module is attached over I2C | °C, V, mm, µm, L |
| `SENSECAP_S2120` | Sensors | Yes — `sensecap_s2120_decoder.js` | `ambient_temperature`, `relative_humidity`, `light_lux`, `barometric_pressure_hpa`, wind speed/direction/gust, `uv_index`, `rain_mm_per_hour` (4113 intensity), `rain_gauge_cumulative_mm` (4213 counter) → `rain_mm_delta`/`rain_mm_today`, `bat_pct` | °C, %RH, hPa, m/s, deg, mm/h, mm |
| `AQUASCOPE_LORAIN` | Sensors | Yes — `aquascope_lorain_decoder.js` | `rain_mm_delta` (from raw 0.5 mm steps), `ambient_temperature`, `bat_v` | mm, °C, V |
| `STREGA_VALVE` | Actuators | Yes — `strega_gen1_decoder.js` | `devices.current_state` (not a `device_data` column), `bat_pct`/`bat_v`, plus Gen1-only `ambient_temperature`/`relative_humidity` (enclosure climate, see below) | °C, %RH |
| `MILESIGHT_UC512` | Sensors | Yes — `milesight_uc512_decoder.js` | `valve_1_state`/`valve_2_state` (text), `valve_1_pulse`/`valve_2_pulse` (integer), `pipe_pressure_kpa` (real) | —, counts, kPa |

File locations for all OSI-authored decoders:
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/` (list with `ls` there; as of 2026-09-14: aquascope_lorain, dragino_lsn50, milesight_uc512, sensecap_s2120, strega_gen1, strega_gen2).
The same directory also holds `agroscope_uplink_transform.js`, the edge→partner-institute IoT forwarding transform (osi-os PR #110) — it is not a device decoder.
`tektelic_agriculture_decoder.js` is the upstream TEKTELIC agriculture sensor codec (one codec for KIWI and CLOVER), vendored unmodified; the bootstrap attaches it to the `OSI KIWI Sensor` and `OSI CLOVER Sensor` profiles when they have no codec, and leaves a codec already there (for example one attached by hand) alone. Kiwi and Clover uplinks are decoded only by this profile codec; Node-RED has no decoder for them. It emits `input5_frequency`/`input6_frequency` for the KIWI watermark inputs, which Process Data accepts beside `watermark1_frequency`/`watermark2_frequency` (the names of the vendor's later decoder).

**VWC note (not implemented on the edge):** `web/react-gui/src/types/farming.ts` types a
`VWC` trigger metric as "planned; typed now", and `docs/channel-manifest.md`
records the canonical `vwc` manifest entry with `edgeField: null` — there is no
local osi-os telemetry column for VWC today. Do not assume `TEKTELIC_CLOVER`
populates a VWC column; treat AGENTS.md's "VWC" catalog label as the intended
sensor capability, not a shipped field.

**Battery quirks (verified in code, not just docs):** the shared footer
(`web/react-gui/src/components/farming/shared/DeviceCardFooter.tsx` →
`deviceCardBattery.ts`, `buildDeviceFooterMeta`) prefers a real `bat_pct` and
**falls back to a voltage-derived percent from `bat_v`** using a fixed LSN50
discharge curve (`getBatteryPercentFromVoltage`, 2.1 V = 0%, 3.6 V = 100%,
clamped) when `bat_pct` is absent or not a valid finite 0-100 value. `DraginoTempCard.tsx` passes both
`batteryPercent={bat_pct}` and `batteryVoltage={bat_v}`, so `DRAGINO_LSN50`
devices that only report `bat_v` still show a footer percentage. This closed
GitHub issue #51 (`osi-os`); it supersedes any older note claiming the LSN50
battery footer is hidden — that was true before the voltage-fallback shipped
(commit `01dc45fa`, "derive lsn50 battery footer percent") and is stale now.

## Soil water tension (SWT)

**Definition (as used here):** SWT is the suction (matric potential) the soil
exerts on water — the force a root must overcome to extract it. Higher tension
means drier soil; lower tension means wetter soil. It is not the same
quantity as VWC (volumetric water content); this repo does not convert
between them.

**Storage and sign convention (verified, load-bearing):**
- Canonical channels are `device_data.swt_1`, `swt_2`, `swt_3` in **kPa**, and
  they are stored and compared as **positive numbers where higher = drier**.
  Verified in three independent places:
  1. The Chameleon resistance→kPa conversion clamps to `[MIN_KPA=0, MAX_KPA=300]`
     — `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`,
     function `resistanceOhmsToKpa`.
  2. The irrigation scheduler compares `meanKpa >= threshold` (drier soil reads as a larger positive kPa); locate the current predicate with the grep in the provenance section
     — `flows.json` node id `5f0d2b7e9b9b1b3a` ("Decide + build actuator cmd +
     build DB logs"). Rising kPa past the threshold triggers irrigation, i.e.
     higher kPa = drier = irrigate.
  3. The GUI's SWT summary bucketing treats low kPa as "Wet" and high kPa as
     "Dry": `mean < 20` → Wet, `mean < 60` → Moderate, else Dry
     (`web/react-gui/src/utils/swt.ts`, `summarizeSwtValues`).
- Legacy `device_data.swt_wm1` / `swt_wm2` are **read-only aliases** for old
  rows (pre-canonicalization); new writes go to `swt_1`/`swt_2`/`swt_3`. Reads
  should coalesce canonical-then-legacy — `flows.json`'s latest-data query uses
  `COALESCE(dd.swt_1, dd.swt_wm1) AS swt_1`.
- `irrigation_schedules.threshold_kpa` is validated `0 < x ≤ 300` for
  non-DENDRO trigger metrics (`flows.json`, "Verify Zone Ownership" node); for
  `trigger_metric = 'DENDRO'` the same column instead holds an **encoded
  1-4 stress level** (1=mild … 4=severe), not a kPa value — do not treat
  `threshold_kpa` as kPa when the metric is DENDRO.
- **Trigger-metric CHECK is a schema contract, not agronomy semantics.** If
  `irrigation_schedules.trigger_metric` accepts or rejects the wrong symbolic
  metrics, verify the current seed and ordered migrations before planning:
  `grep -n "trigger_metric" database/seed-blank.sql` and
  `ls database/migrations/ordered/`. Route any CHECK change through
  **osi-schema-change-control**; this skill only explains what the metrics mean.

**Depth columns:** `devices.chameleon_swt1_depth_cm`, `chameleon_swt2_depth_cm`,
`chameleon_swt3_depth_cm` record the physical burial depth of each Chameleon
sensor channel (`database/seed-blank.sql`). Per-device calibration
coefficient columns (`chameleon_swt[123]_[abc]`) were **removed** in the
2026-05-19 migration in favor of the global `chameleon_calibrations` table
(see below) — depth stayed device-local because it's installation geometry,
not a sensor calibration constant.

### pF (soil water tension, logarithmic)

pF is the base-10 logarithm of tension expressed in hPa (1 kPa = 10 hPa); it
compresses the wide dynamic range of soil suction into a small number
range (roughly 0-4.5) more familiar to some agronomists.

**pF is never stored.** It is derived at read time everywhere it is shown —
GUI display, CSV export, and (per the sync contract) any cloud consumer.
There is no `swt_*_pf` column and no schema change was needed to add it
(osi-os PR #98, "swt-pf-display-csv", merged as `22cffe6d`).

**Exact formula, verified in `web/react-gui/src/utils/swt.ts`:**
```ts
export const PF_FLOOR_KPA = 0.1;
export function kpaToPf(kpa: unknown): number | null {
  const value = toFiniteSwtValue(kpa);
  if (value === null) return null;
  if (value <= PF_FLOOR_KPA) return 0;
  return Math.log10(value * 10);
}
```
So **`pF = log10(kPa * 10)`**, and the inverse `pfToKpa` is
`kPa = 10^pF / 10` (exact above the floor; 0 pF maps to 0.1 kPa; a negative
pF is rejected). **pF is never shown below 0**: a finite kPa at or below 0.1
(a saturated probe reads 0 kPa) shows the floor `0.00 pF` and exports `0`.
Missing or non-finite kPa still produces `null` pF (consistent with the
missing-data rule below). kPa displays are unaffected by the floor.

This exact formula, and its rounding, is pinned as
a cross-runtime contract in `docs/contracts/sync-schema/canonicalization.md`
("SWT pF Derivation") with golden vectors edge JS / GUI TS / server Java must
all match, e.g. 30 kPa → `2.4771212547196626` (2.48 at 2 dp, 2.4771 at 4 dp),
0 or negative kPa → `0` (the floor), missing kPa → `null`. Display rounds pF to 2 decimals
(`formatSwtValue`); CSV export rounds to 4 decimals.

**CSV pairing:** each finite SWT kPa row exported gets a paired `_pf` row — verified
in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`:
`channel_key: \`${channel.id}_pf\`` and `series_label: \`${kpaRow.series_label} (pF)\`` — with `unit: 'pF'`.

**What did NOT ship:** an earlier spec draft considered adding
`threshold_unit` + `threshold_pf` authoring columns to `irrigation_schedules`
so operators could author thresholds in pF. That was descoped — PR #98 is
"zero-schema": pF is display/export only, and the scheduler **always**
compares in kPa regardless of the operator's display preference (comparing
in pF would silently change trigger behavior, since a mean of pF values is a
geometric-mean-like quantity in kPa space — Jensen's inequality). If you see
a document proposing `threshold_pf`, treat it as an unimplemented proposal,
not current behavior.

## Chameleon sensor stack

**What it is:** the VIA Chameleon module is a 3-channel resistance-based soil
water sensor array, read over I2C by a Dragino LSN50 running OSI custom
firmware (`feature/chameleon-i2c-reader`, standalone repo, not part of
osi-os). The LSN50 uplink (FPort 2, LSN50 MOD=2 "3ADC+IIC" frame) carries a
Chameleon extension: per-channel temperature-compensated and raw resistances,
a status byte, soil temperature, and (V1 payload) an 8-byte array ID. Two
payload versions exist and are both decoded —
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js`,
functions `decodeChameleonV1`/`decodeChameleonV2` (dispatched by
`isChameleonV1Frame`/`isChameleonV2Frame` on byte 8 of the payload).

**Status flags exposed by the decoder** (verified field names):
V1: `Chameleon_I2C_Missing`, `Chameleon_Timeout`, `Chameleon_Temp_Fault`,
`Chameleon_ID_Fault`, `Chameleon_CH1_Open`/`CH2_Open`/`CH3_Open`. V2 collapses
the first two into `Chameleon_Data_Invalid`, plus `Chameleon_Temp_Fault`,
`Chameleon_ID_Fault`, and the same per-channel `_Open` flags (derived from an
open-circuit resistance sentinel of 10,000,000 Ω rather than a status bit).
`i2c_missing`/`timeout`/`data_invalid` downstream in `chameleon_readings` and
the calibration helper trace back to these flags.

**Calibration model — global table, verified formula:**
`chameleon_calibrations` is keyed by `array_id` (uppercase 16-char hex,
normalized by `normalizeArrayId`), with per-sensor coefficients `a`, `b`, `c`
for each of the 3 channels. The conversion, verified in
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`,
function `resistanceOhmsToKpa`:

```
resistance_kΩ = resistance_Ω / 1000
kPa = a * ln(resistance_kΩ) + b * resistance_kΩ + c
```

...clamped to `[0, 300]` kPa and rounded to 2 decimals; resistances `<= 0` or
`>= 10,000,000 Ω` (open circuit) are rejected as `null` before the formula
runs. `calibration_status` is `'calibrated'` (a matching `chameleon_calibrations`
row exists), `'pending'` (Chameleon enabled, no calibration row yet), or
implicitly `'unknown'` when the array ID itself can't be read.
`chameleon_calibration_misses` is a 24-hour negative cache keyed by
`array_id` so the sync worker doesn't hammer the cloud for IDs it just
learned are missing. The Node-RED sync worker polls
`/api/v1/sync/chameleon/calibrations/lookup` every 30 s (same cadence as
pending-commands) for any outstanding misses, persists new rows locally, and
backfills previously-pending `device_data.swt_*` values.

**Raw vs canonical:** `chameleon_readings` is the raw/diagnostic mirror (raw +
compensated resistances, status flags, array ID, calibration_status) —
useful for protocol debugging. `device_data.swt_1/swt_2/swt_3` are the
canonical application values that scheduler, GUI, and cloud sync all read.
If you repair history from `chameleon_readings` + `chameleon_calibrations`,
you must also update `device_data`. The live `INSERT`-only sync trigger does
not fire on that `UPDATE`, but it is still carried: `trg_sync_device_data_dirty_au`
marks the row in `sync_history_dirty_keys`, which the history correction
phase picks up. Do not enqueue explicit `DEVICE_DATA_APPENDED` events for
the repair — every such event has `sync_version` 0, and the cloud rejects a
changed payload at an equal version as `equal_version_payload_conflict`.
Update by row `id`: `device_data` has no UNIQUE(deveui, recorded_at)
(AGENTS.md, "Chameleon calibration global table").

**A `DRAGINO_LSN50` may be a WATERMARK node, not a Chameleon board.** FPort 11
+ profile 3 uplinks decode to soil-tension resistance readings stored in
`watermark_readings` and surfaced as `latest_data.watermark`; the two firmware
variants are mutually exclusive on one board. Before troubleshooting SWT on a
`DRAGINO_LSN50` as a Chameleon I2C fault, check whether the device is a
WATERMARK node instead.

**Wiring rule (one line; the field incident summary lives elsewhere):** power the VIA
Chameleon I2C reader from the LSN50's own `VDD` rail (3.3-3.6 V) when SDA/SCL
are wired directly to the LSN50 STM32 I2C pins. Do not power it from switched
5 V without a proper bidirectional I2C level shifter plus power isolation —
the reader's pull-ups follow VCC and a switched-off 5 V rail can back-power
the board through SDA/SCL. Field incident summary:
`docs/hardware/chameleon-reference.md` (section "Field incident: reader powered from a different rail than the bus"); for
troubleshooting a live `i2c_missing` symptom, use **osi-debugging-playbook**
instead of re-deriving this here.

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
1. **`station_fao56`** — daily FAO-56 Penman-Monteith (`et0.js`'s
   `fao56Et0`, ported from the cloud's `WeatherMath.fao56Et0`) from a
   SenseCAP S2120 assigned to the zone (`weather_station_zones`), whose
   uplinks `osi-station-hours` aggregates into `weather_station_hours`
   (radiation from `light_lux / luxPerWm2`). A day whose radiation sum is
   below 0.15 × Ra, or that reads 0 in an hour whose extraterrestrial
   radiation exceeds 1 MJ/m², falls to the next tier (covered or failing
   light sensor).
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

## Rain semantics

**Cardinal rule (engineering playbook, Prime Directive 3 — applies to ALL
sensors, not just rain):** a day with zero *samples* is "no data", never
"0.0 mm dry". Ingest writes real zeros when it is actually dry; never
substitute a plausible default for an absent measurement. This repo once
shipped a `-42 kPa` fallback and a `rootVwcPct ?? 24` fallback — both looked
like real agronomy and misled operators before being caught. `null` must
propagate end to end and render as an explicit "unavailable" state, not a
guessed number (`docs/engineering-playbook.md`, "1. Prime directives", item 3).

**AQUASCOPE_LORAIN (Aqua-Scope LoRain / RANLWE01):** reports **interval**
rainfall, not cumulative. The vendor payload command `0x06 0x81` carries raw
0.5 mm tip-bucket steps; the decoder
(`aquascope_lorain_decoder.js`) keeps the vendor value as `rainlevel` /
`rain_tips_delta` and exposes a normalized `rain_mm_delta = rainlevel * 0.5`
in millimeters directly — there is no delta computation against a previous
reading because each uplink already reports the interval, not a running
total. Because each report is already a delta, duplicate or out-of-order
uplinks must not be aggregated twice (AGENTS.md). Public onboarding uses
FPort `10`; the legacy firmware decoder path uses FPort `2` — the decoder
accepts both. JoinEUI/AppEUI `4943485448592021` is public (already in
AGENTS.md); AppKey is fetched from Aqua-Scope with DevEUI + email and must
never be stored in this repo. Assigned LoRain gauges update
`zone_daily_environment` with `rain_source='aquascope_lorain'`.

**SENSECAP_S2120:** two different rain quantities (SenseCAP S2120 user
guide, sections 10.2, 10.3.1 and 13.3):
- measurementId `4113` ("Rain Gauge", frame `02` before firmware v2.0, `4B`
  from v2.0) is rainfall **intensity** in mm/h, resolution 0.001. The device
  derives it as six times the rainfall of the past ten minutes. It is a
  rate, never a counter: a drop in intensity is not a reset.
- measurementId `4213` ("Rain Accumulation", frame `4C`, firmware v2.0 and
  later) is **cumulative** rainfall in mm.

`flows.json` node `s2120-ingest-fn` ("Ingest S2120", the one S2120 writer;
rules in `osi-rain`: `parseS2120Measurements`, `deriveS2120Counter`,
`deriveS2120Legacy`, `ingestS2120Uplink`) stores `4113` as
`device_data.rain_mm_per_hour` and `4213` as
`device_data.rain_gauge_cumulative_mm`, and derives the interval amount
`rain_mm_delta` (kept to 0.001 mm; round only for display):
- **4213 present:** counter differencing against the previous stored
  `rain_gauge_cumulative_mm` of that DevEUI. The first `4213` row of a device
  gets `rain_delta_status='cumulative_baseline'`; only rows from that marker
  on are a counter baseline, because older rows may hold `4113` values that
  ingest before this contract stored in `rain_gauge_cumulative_mm`. A lower
  `4213` is `counter_reset` and becomes the new baseline.
- **4213 absent (firmware before v2.0):** `rain_gauge_cumulative_mm` stays
  NULL. `4113 / 6` is the interval amount only when the time since the
  previous rain uplink of the device is the vendor's 10-minute window
  (600 s ± 60 s); then the windows tile without gap or overlap. Any other
  interval (lost uplink, 5/15/30/60-minute cadence) or the first uplink
  leaves the amount NULL with `intensity_only` or `first_sample`.
- A device that has a `cumulative_baseline` row never integrates intensity:
  an uplink without `4213` gets `intensity_only`, and the next `4213` uplink
  counts that rain once.

`rain_delta_status` values: `cumulative_baseline`, `first_sample`,
`counter_reset`, `intensity_only`, `duplicate_timestamp`/`out_of_order` (a
same-or-later rain row already exists), `invalid_interval`,
`ambiguous_identity` (no ChirpStack `deduplicationId`), or `ok`.
Only `ok` samples have a non-null `rain_mm_delta`/`rain_mm_per_10min`, and only
those reach `zone_daily_environment`: in the same transaction the zone day is
set to the device's `ok` total inside that zone's local day, with
`rain_source='sensecap_s2120'` (multi-zone via the `weather_station_zones`
junction table, since one S2120 can serve multiple zones; else the device's
own zone). A zero increment never takes over a day another source owns.
Every uplink also gets a `rain_observations` row (`instrument_type
'SENSECAP_S2120'`, `frame_kind` `counter`/`ordinary`/`status`); a repeated
delivery or a retransmission is a duplicate, and a counter frame older than
the latest rain row carries `late_counter_frame` and is never counted.
`rain_mm_today` is the device's day in its zone timezone (device zone, else
first weather-station zone, else UTC), never the gateway host day. S2120 totals stored before this contract (ingest that differenced
`4113`) are not validated measurements; `scripts/assess-s2120-rain-history.js`
reports them per device and day against a DB copy.

## LoRaWAN / ChirpStack model (as used here)

- **OTAA (Over-The-Air Activation):** the device negotiates session keys with
  the network at join time instead of shipping hardcoded session keys. All
  OSI device types join via OTAA.
- **DevEUI:** a device's globally unique 64-bit identifier (16 hex chars);
  primary key for `devices.deveui`.
- **JoinEUI / AppEUI:** identifies the join server a device should join
  through (older spec name is AppEUI, 1.1 renamed it JoinEUI). Aqua-Scope
  LoRain's is `4943485448592021` (public, already in AGENTS.md).
- **AppKey:** the root key used to derive OTAA session keys. Device-specific,
  never stored in this repo.
- **FPort:** the LoRaWAN application port number in an uplink/downlink,
  used here to distinguish payload formats/versions within a device family
  (LoRain FPort `10` vs legacy `2`; LSN50 FPort `2` sensor data vs FPort `5`
  config/status).
- **Uplink / downlink:** device→network and network→device LoRaWAN frames.
- **Class A:** the lowest-power LoRaWAN device class — the device only opens
  receive windows right after it transmits (no scheduled downlink reception
  otherwise). All OSI device types listed here are Class A.

**Device-type discrimination is never hardcoded** to a ChirpStack application
UUID (those are generated per-installation at bootstrap). It's done via
`CHIRPSTACK_PROFILE_*` env vars with a `deviceProfileName` fallback — the
exact env semantics belong to **osi-config-and-flags**, not here. All MQTT
uplink subscriptions use the wildcard topic `application/+/device/+/event/up`
(`scripts/check-mqtt-topics.sh` enforces this). ChirpStack apps are split
`Sensors` (all sensor device types) vs `Actuators` (`STREGA_VALVE`) — AGENTS.md
device catalog.

## STREGA valve semantics

**`OPEN_FOR_DURATION` is the only normal-operation command.** The valve
firmware closes itself when the commanded duration elapses; there is no
paired "open" + "close" command pair in normal use, and a bare `CLOSE`
command must never be sent during normal operation or testing/debugging —
the valve is designed to self-close, and sending an unexpected CLOSE is not
a supported operational pattern. If you need to end an irrigation early,
that's a cancel, not a close (next paragraph).

**Operator cancel:** `POST /api/v1/valves/:deveui/cancel`
(`flows.json`, url `/api/v1/valves/:deveui/cancel`) flushes the pending
ChirpStack device downlink queue and marks the most recent active
`valve_actuation_expectations` row `CANCELLED`.

**Expectation lifecycle:** `valve_actuation_expectations` (verified schema,
`database/seed-blank.sql`) records `commanded_at`, `commanded_duration_seconds`,
`expected_close_at`, `observed_open_at`/`observed_close_at`,
`reconciliation_state` (default `'PENDING_OBSERVATION'`, active states are
`PENDING_OBSERVATION` and `OBSERVED_RUNNING`), `cancel_reason`, and an
optional `estimated_gross_liters` with its `volume_source`. The
reconciliation monitor reads live STREGA state from `devices.current_state`
and last-uplink time from `device_data.recorded_at` (AGENTS.md).

**Estimated vs measured volume — kept separate:** `zone_irrigation_calibration`
stores a per-zone `measured_flow_rate_lpm` (from a real flow-meter
measurement) used only to *estimate* `valve_actuation_expectations.estimated_gross_liters`
for a given commanded duration. `zone_daily_environment.flow_liters` is
reserved for actually-measured flow-meter data — the two must never be
merged into one column, so a farm without a flow meter never gets a
volume number that looks measured but isn't.

### STREGA on-valve scheduler

Separate from `OPEN_FOR_DURATION` above: STREGA valves also carry their own
weekly scheduler in firmware, which the gateway compiles and pushes
(`osi-valve-control`, spec
`docs/superpowers/specs/2026-08-19-valve-control-design.md`). FPorts:

- **14–20** — Gen1 weekday plans, one FPort per weekday (`14 + weekday`,
  `weekday` 0=Sunday…6=Saturday); each downlink carries that weekday's whole
  window list, up to 4 on/off pairs.
- **25** — Gen2 day-mask plan: one payload can target several weekdays that
  share the same window list.
- **21** — scheduler status: resume, skip-today, pause, or (never sent by
  this gateway except a documented Gen2 fallback) delete-all.
- **12** — clock set (Gen1): local wall-clock digits in the schedule's
  timezone.
- **13** — clock request (Gen2): triggers ChirpStack's `DeviceTimeReq`.

Every weekday is capped at 4 windows; a push that would exceed that is
refused before it is queued. **The valve never reports its on-board
scheduler back over LoRaWAN** — there is no read-back FPort — so the gateway
cannot reconcile drift by asking the valve what it currently holds; it can
only re-push. This is also why a Bluetooth edit made directly on an SV2 is
invisible to the gateway until the next gateway-initiated push. Vendor
encoder/decoder references for both generations are vendored at
`docs/hardware/strega-codecs/`.

### `strega_model` and `strega_generation` are independent axes

`devices.strega_model` (`STANDARD` or `MOTORIZED`) and
`valve_settings.strega_generation` (`GEN1` or `GEN2`) answer different
questions and must not be conflated. `strega_model` names the physical valve
hardware: a motorized ball valve actuates and reports differently from a
standard solenoid, independent of firmware. `strega_generation` names which
ChirpStack device profile and codec the valve's controller board speaks:
Gen1's weekday-per-FPort scheduler and Gen1 clock-set (FPort 12), or Gen2's
daymask scheduler (FPort 25) and `DeviceTimeReq`-based clock (FPort 13). A
MOTORIZED valve can be either generation, and a STANDARD valve can be either
generation. The two columns vary independently; neither is derived from the
other.

`OPEN_FOR_DURATION` (the earlier "STREGA valve semantics" section) does not
vary with `strega_generation`: both generations accept the identical command
and close themselves identically when the commanded duration elapses. Only
the on-valve *scheduler* frames differ between generations, per the FPort
table above.

The Gen2 vendor decoder
(`docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up`)
names the decoded valve-state field `Actuator`, not `Valve` (the name Gen1's
decoder uses for the same concept). `strega-process-fn` in flows.json accepts
`Actuator` as an alias so both generations' current-state derivation reads
the same way downstream.

### Enclosure temperature and humidity: Gen1 only, and not field weather

Gen1 STREGA valves report enclosure climate on the periodic uplinks that
carry the temperature/humidity block; `strega_gen1_decoder.js` gates
`Temperature` and `Hygrometry` on a payload marker, and its counter-only
and analog-only periodic variants omit both fields rather than sending a
placeholder. When present, the two values derive from two 16-bit fields as
`(v/65536)*165-40` and `(v/65536)*100`. Two independent guards null the
sentinel: the decoder itself tests `box_temp === 65535 && box_hum === 65535`
(`strega_gen1_decoder.js`, the `box_temp === 65535 && box_hum === 65535` guard, added in `d261d2c7`), and `strega-process-fn`
in flows.json separately tests the decoded pair 125 °C / 100 %
(`normalizeStregaEnvironment`) — the vendor codec at
`docs/hardware/strega-codecs/ChirpStack-STREGA-CODEC-Decoder-Gen1` has no
such guard. Both of ours landed together in `d261d2c7`, so treat them as one
defence in two places rather than one compensating for the other — and note
that ChirpStack is provisioned with our guarded decoder, not the vendor file
(`chirpstack-bootstrap.js`, the `stregaCodecPath` and `stregaGen2CodecPath` provisioning; Gen2 is provisioned from `strega_gen2_decoder.js`, not from the vendor file). The values
land in `device_data.ambient_temperature` and `relative_humidity`, the same
columns sensor devices use.

**Gen2 (SV2) payloads carry neither field, and no decoding will produce
them.** Confirmed three independent ways:
1. The Gen2 vendor decoder
   (`docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up`)
   emits no temperature or humidity field in any of its four return shapes
   (ack port 10, ack port 24, the `default` ack branch, and the standard
   periodic uplink).
2. The SV2 manual's periodical uplink
   (`/home/phil/kDrive/OSI OS/Hardware/STREGA/Gen2/HHW_SV2_STREGA_Smart_valve_Manual.pdf`,
   payload format pp. 51-53) is 3 bytes of battery millivolts plus one
   fully-mapped info-status byte (Class, Power, DI_1/LSC, DI_0/LSO,
   valve-connection, valve-position), optionally followed by a counter;
   no spare bits, no spare bytes.
3. The manual's "Data Read" specification (p. 110) names valve state,
   battery, device ID, digital inputs, counter, alarm, and RSSI, and
   nothing climate-related — though the list ends "etc.", so this
   corroborates absence from the payload rather than proving the board has
   no sensor fitted.

No Gen2 payload carries these values, and no decoder change will produce
them; whether the SV2 board has a sensor that is simply never reported is
a separate question this evidence does not settle. If a future engineer
asks "can we get temperature off the Gen2 valves", the payload-level
answer is no — re-reading the decoder or the manual will not change it.

**This is enclosure climate, not field weather.** The vendor's own variable
names are `box_temp` and `box_hum`: the sensor sits inside the valve's
buried housing, not in the crop canopy. Rising humidity in that box means
water ingress, a maintenance signal that belongs beside battery level and
last-contact time, not a growing-condition reading. The value lands in
`device_data.ambient_temperature`, the same column `SENSECAP_S2120` and
other weather sensors write to, which makes it easy to mistake for zone
air temperature. It must never be used as zone air temperature and never
fed into an agronomy calculation (SWT scheduling, ET0, dendrometer stress).

`osi-valve-control` (`store.js`, `api.js`) reads these columns back out for
the valve list as `enclosure_temperature_c`, `enclosure_humidity_pct`, and
`enclosure_measured_at`. The two readings are selected independently (a
valve can report one and not the other), and both are bounded to the newest
row within a 7-day window, so a stale reading reports as absent rather than
current. `store.js`'s SQL does not filter by generation — a valve
re-pointed GEN1→GEN2 by the ACK-ledger recovery path still returns any
historical enclosure rows it wrote as Gen1; suppressing Gen2 happens at the
interface, not the query. `ValveTile.tsx` renders whichever of the two
values is present and goes silent only when both are absent (and always
for Gen2); `StregaValveCard.tsx` explains the two distinct absences: "no
reading yet" for a Gen1 valve that has not reported one, and "not measured
on Gen2" for a payload that cannot carry it.

## Common mistakes

- Assuming SWT is negative or that lower kPa means drier — it is the
  opposite here: positive kPa, higher = drier, verified by the scheduler's
  own `meanKpa >= threshold` comparison.
- Treating `swt_wm1`/`swt_wm2` as writable in new code — they are read-only
  legacy aliases; write to `swt_1`/`swt_2`/`swt_3`.
- Assuming pF is stored anywhere, or that the scheduler compares in pF — it
  doesn't; pF is derive-at-read display/export only, and the scheduler
  always compares kPa.
- Assuming `TWD_rel` is available on the edge dashboard — it's cloud-only
  (v6, osi-server); the edge still runs its own absolute-µm v5 TWD/MDS.
  Don't conflate the two TWD implementations.
- Treating the partner institute dendrometer controller doc as shipped behavior —
  it explicitly says "Draft design, not shipped behavior."
- Assuming `TEKTELIC_CLOVER` reports VWC today — it's typed for a future
  channel but has no populated edge field (`edgeField: null` in the channel
  manifest).
- Assuming ET0 is still cloud-only — the edge now computes it itself
  (`osi-agronomy-daily`, three tiers); see the "ET0" section above.
- Treating a day with zero rain samples as "0.0 mm" — that conflates
  "no data" with "confirmed dry"; only ingest that actually observed zero
  should write zero.
- Confusing LoRain's interval rain (`rain_mm_delta` computed directly from
  a raw step count, no history lookup needed) with S2120's cumulative-counter
  delta (`4213` differenced against the previous stored
  `rain_gauge_cumulative_mm` row from the device's `cumulative_baseline` on,
  with explicit `counter_reset`/`duplicate_timestamp` guards).
- Treating S2120 measurement `4113` as cumulative rain. It is intensity in
  mm/h (six times the rain of the past ten minutes); only `4213` is a counter.
- Sending a bare `CLOSE` to a STREGA valve for any reason, including test
  cleanup — always use a short `OPEN_FOR_DURATION` or the cancel endpoint.
- Assuming the DRAGINO_LSN50 battery footer is always hidden because the
  device only reports `bat_v` — the voltage-derived fallback (issue #51)
  means it now shows a computed percentage; this contradicts older notes
  that predate that fix.
- Treating `strega_model` and `strega_generation` as the same axis, or
  assuming one predicts the other. `strega_model` is hardware (STANDARD vs
  MOTORIZED); `strega_generation` is controller firmware/codec (GEN1 vs
  GEN2); they vary independently.
- Assuming a Gen2 (SV2) STREGA valve's temperature/humidity gap can be
  closed with a decoder change — the SV2 payload has no spare bits or
  bytes for it (manual pp. 51-53, 110); nothing the device transmits
  carries it.
- Reading `device_data.ambient_temperature` on a `STREGA_VALVE` row as zone
  air temperature — it is the valve's own enclosure (`box_temp`), and must
  never feed an agronomy calculation.

## Provenance and maintenance

Re-verify these if this skill's answers seem stale:

```bash
# SWT sign convention: scheduler comparison direction
grep -n "const irrigate" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json

# Chameleon resistance->kPa formula and clamp bounds
sed -n '1,50p' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js

# pF formula + golden vectors (must match GUI TS, edge JS, and server Java)
sed -n '1,60p' web/react-gui/src/utils/swt.ts
sed -n '85,110p' docs/contracts/sync-schema/canonicalization.md

# irrigation_schedules trigger_metric CHECK (confirm current schema contract)
grep -n "trigger_metric" database/seed-blank.sql

# Dendrometer edge (v5) vs cloud (v6) ownership
grep -n "Dendrometer Analytics v5" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
sed -n '1,40p' docs/architecture/dendrometer-analytics-v6.md

# ET0 on the edge (three tiers, FAO-56 math) and the cloud's Java reference it was ported from
sed -n '1,80p' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js
grep -n "stationDayInputs\|radiationImplausible\|resolveDay" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.js
grep -n "et0\|Et0" ../osi-server/backend/src/main/java/org/osi/server/analytics/WeatherMath.java  # sister-repo checkout required, path relative to this repo root

# Rain aggregation (S2120 cumulative-delta status machine; LoRain interval decoder)
grep -n "rainDeltaStatus\|rain_delta_status" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
sed -n '1,130p' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js

# Battery footer fallback behavior (confirm issue #51 / bat_v fallback still present)
sed -n '1,55p' web/react-gui/src/components/farming/shared/deviceCardBattery.ts

# VWC not-implemented status
grep -n "VWC" web/react-gui/src/types/farming.ts docs/channel-manifest.md

# STREGA cancel endpoint + expectation table
grep -n "valves/:deveui/cancel" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
grep -n "CREATE TABLE valve_actuation_expectations" -A 20 database/seed-blank.sql

# STREGA on-valve scheduler FPorts + window cap
grep -n "Schl_Port\|Schl_status_Port\|RTC_Port" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/ack.js
sed -n '1,40p' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/plan.js
```

Cross-reference AGENTS.md's "Device catalog", "Chameleon calibration global
table", "Aqua-Scope LoRain", "STREGA timed irrigation", and "Valve control"
sections — this skill expands on those, it does not override them. If this
skill and AGENTS.md ever disagree, AGENTS.md wins; file an issue to
reconcile rather than silently trusting either.
