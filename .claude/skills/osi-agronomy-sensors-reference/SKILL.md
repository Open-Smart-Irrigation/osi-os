---
name: osi-agronomy-sensors-reference
description: Use when interpreting soil water tension (SWT) kPa or pF values, Chameleon sensor calibration/wiring, dendrometer TWD/MDS output, rain gauge aggregation (LoRain/S2120), ET0/evapotranspiration questions, deciding which device_data column a sensor writes to, STREGA valve command semantics, or any device-payload/decoder question. Covers KIWI_SENSOR, TEKTELIC_CLOVER, DRAGINO_LSN50, SENSECAP_S2120, AQUASCOPE_LORAIN, STREGA_VALVE.
---

# OSI Agronomy & Sensors Reference

## Overview

This skill is the domain model for how OSI OS represents soil, plant-water, and
weather measurements in the database, the scheduler, and the dashboard. It
answers "what does this number mean and where does it live", not general
agronomy theory. Every claim below was checked against the code or docs named
next to it, as of 2026-07-06 (worktree `feat/agent-skill-library`,
`osi-os` HEAD `22cffe6d`).

## When to use / When NOT to use

Use this skill when you need to:
- Interpret a stored SWT/kPa/pF value, or decide whether a number is "wet" or "dry".
- Understand Chameleon resistance-to-kPa calibration or the array_id lookup flow.
- Explain dendrometer MDS/TWD/TWD_rel output or find which side (edge vs cloud) computes it.
- Explain rain aggregation semantics for LoRain or S2120, or a "missing vs zero" rain question.
- Determine which `device_data` column a given sensor/device type populates.
- Explain STREGA valve command semantics (`OPEN_FOR_DURATION`, cancel).
- Explain LoRaWAN join/uplink vocabulary (OTAA, FPort, DevEUI...) as used by this system.

Do NOT use this skill for (route instead):
- Debugging a symptom like `i2c_missing=1`, a data gap, or a stuck sync — **osi-debugging-playbook**.
- Deploying to or repairing a live Pi, backups, restart procedures — **osi-live-ops-runbook**.
- Mechanically editing `flows.json` (node shapes, wiring function nodes) — **osi-flows-json-editing**.
- Adding/altering a table, column, or migration — **osi-schema-change-control**.
- `CHIRPSTACK_PROFILE_*` env vars, device-profile provisioning, feature flags — **osi-config-and-flags**.

## Device catalog and units quick-reference

| Device | ChirpStack app | Custom OSI decoder? | Primary `device_data` fields | Units |
|---|---|---|---|---|
| `KIWI_SENSOR` | Sensors | No (TEKTELIC/vendor payload, no file under `codecs/`) | `swt_1`, `swt_2` (via legacy `swt_wm1/2` aliasing), `light_lux`, `ambient_temperature`, `relative_humidity` | kPa, lux, °C, %RH |
| `TEKTELIC_CLOVER` | Sensors | No | same shape as KIWI; VWC is **typed but not populated** (see VWC note below) | °C, %RH; VWC not stored |
| `DRAGINO_LSN50` | Sensors | Yes — `dragino_lsn50_decoder.js` | `ext_temperature_c` (DS18B20), `adc_ch0v/adc_ch1v`, `bat_v`, plus MOD-specific: `dendro_position_mm`/`dendro_*` (dendrometer), `rain_*` (rain gauge), `flow_*` (flow meter), and Chameleon `swt_1/2/3` when a VIA Chameleon module is attached over I2C | °C, V, mm, µm, L |
| `SENSECAP_S2120` | Sensors | Yes — `sensecap_s2120_decoder.js` | `ambient_temperature`, `relative_humidity`, `light_lux`, `barometric_pressure_hpa`, wind speed/direction/gust, `uv_index`, `rain_gauge_cumulative_mm` → `rain_mm_delta`/`rain_mm_today`, `bat_pct` | °C, %RH, hPa, m/s, deg, mm |
| `AQUASCOPE_LORAIN` | Sensors | Yes — `aquascope_lorain_decoder.js` | `rain_mm_delta` (from raw 0.5 mm steps), `ambient_temperature`, `bat_v` | mm, °C, V |
| `STREGA_VALVE` | Actuators | Yes — `strega_gen1_decoder.js` | `devices.current_state` (not a `device_data` column), `bat_pct`/`bat_v` | — |

File locations for all OSI-authored decoders:
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/{aquascope_lorain_decoder.js, dragino_lsn50_decoder.js, sensecap_s2120_decoder.js, strega_gen1_decoder.js}`.
KIWI/CLOVER have no file here — their payload arrives already decoded (vendor/ChirpStack-side codec), which is why the table above says "No".

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
clamped) when `bat_pct` is absent. `DraginoTempCard.tsx` passes both
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
  2. The irrigation scheduler's decision rule is `const irrigate = (meanKpa >= threshold);`
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
- **Known schema gap (informational, not this skill's fix):** the shipped
  `irrigation_schedules` CHECK constraint (`database/seed-blank.sql`) still
  only allows `trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG')`, while the
  API/GUI have accepted `SWT_1`/`SWT_2`/`SWT_3`/`DENDRO` since 2026-06-24/25.
  This is a live P0 tracked as osi-os issue #92 — a schema/migration concern,
  see **osi-schema-change-control**, not an agronomy modeling question.

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
// pF = log10(tension in hPa); 1 kPa = 10 hPa. Non-positive tension has no pF.
export function kpaToPf(kpa: unknown): number | null {
  const value = toFiniteSwtValue(kpa);
  if (value === null || value <= 0) return null;
  return Math.log10(value * 10);
}
```
So **`pF = log10(kPa * 10)`**, and the inverse `pfToKpa` is
`kPa = 10^pF / 10`. Non-positive, non-finite, or missing kPa produces `null`
pF — there is no clamping and no substitute value (consistent with the
missing-data rule below). This exact formula, and its rounding, is pinned as
a cross-runtime contract in `docs/contracts/sync-schema/canonicalization.md`
("SWT pF Derivation") with golden vectors edge JS / GUI TS / server Java must
all match, e.g. 30 kPa → `2.4771212547196626` (2.48 at 2 dp, 2.4771 at 4 dp),
0 or negative kPa → `null`. Display rounds pF to 2 decimals
(`formatSwtValue`); CSV export rounds to 4 decimals.

**CSV pairing:** each SWT kPa row exported gets a paired `_pf` row — verified
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
you must also update `device_data` and enqueue `DEVICE_DATA_APPENDED` sync
events, because the live sync trigger fires on `INSERT`, not historical
`UPDATE` (AGENTS.md, "Chameleon calibration global table").

**Wiring rule (one line; full analysis lives elsewhere):** power the VIA
Chameleon I2C reader from the LSN50's own `VDD` rail (3.3-3.6 V) when SDA/SCL
are wired directly to the LSN50 STM32 I2C pins. Do not power it from switched
5 V without a proper bidirectional I2C level shifter plus power isolation —
the reader's pull-ups follow VCC and a switched-off 5 V rail can back-power
the board through SDA/SCL. Full field diagnosis:
`docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md`; for
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

**Agroscope dendrometer controller — draft only:**
`docs/architecture/agroscope-dendrometer-controller.md` begins "**Status:**
Draft design, not shipped behavior." It describes a future opt-in
`controller_mode='dendrometer'` architecture that would compare against
Agroscope's `Tree_HSMM`/`Tree_irrigator` reference logic. Treat it purely as
a design reference, not current runtime behavior, and do not cite it as if
MDS/TWD already work this way.

## ET0 (reference evapotranspiration)

**Concept, not implemented on the edge as of 2026-07-06.** ET0 exists only in
`osi-server` (cloud), in `backend/src/main/java/org/osi/server/analytics/{WeatherMath.java,Et0Resolver.java}`,
merged via osi-server PR #46 ("per-zone weather source (cloud Phases 1-2)").
It is resolved per irrigation zone through a tiered `Et0Resolver`:
1. **Native ET0** from a weather source that already supplies one
   (Open-Meteo's own FAO-56 value) — used as-is.
2. **FAO-56 Penman-Monteith**, computed locally (`WeatherMath.fao56Et0`) when
   the source instead supplies humidity + wind + solar radiation.
3. **Hargreaves-Samani** (`WeatherMath.hargreavesEt0`, needs only Tmin/Tmax +
   latitude + day-of-year) as the final fallback.

There is no ET0 field in the edge `device_data`/`zone_daily_environment`
schema and no edge computation of it — this is a cloud/`osi-server`-owned
capability. If asked "does the edge compute ET0", the answer is no.

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

**SENSECAP_S2120:** reports a **cumulative** rain gauge counter
(measurementId `4113`, "Rain Gauge", and `4213`/"Rain Accumulation" on an
alternate frame), unlike LoRain's interval reporting. The edge computes the
delta itself in `flows.json` node `s2120-process-fn` ("Process S2120") by
comparing the new cumulative value against the most recent prior
`device_data.rain_gauge_cumulative_mm` for that DevEUI, with explicit status
handling exposed as `rain_delta_status`: `first_sample` (no prior row),
`counter_reset` (new cumulative value is lower than the previous one),
`duplicate_timestamp`/`out_of_order` (a same-or-later prior row already
exists at/after this timestamp), `invalid_interval`, or `ok`. Only `ok`
samples produce a non-null `rain_mm_delta`/`rain_mm_per_hour`/`rain_mm_per_10min`
and only those flow into `zone_daily_environment` aggregation
(`s2120-rain-agg-fn`, "Aggregate Zone Rain"), which upserts
`rain_source='sensecap_s2120'` and accumulates `rainfall_mm` per zone/day
(multi-zone via the `weather_station_zones` junction table, since one S2120
can serve multiple zones).

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
- Treating the Agroscope dendrometer controller doc as shipped behavior —
  it explicitly says "Draft design, not shipped behavior."
- Assuming `TEKTELIC_CLOVER` reports VWC today — it's typed for a future
  channel but has no populated edge field (`edgeField: null` in the channel
  manifest).
- Assuming ET0 is computed on the edge — it is cloud-only
  (`osi-server` `Et0Resolver`/`WeatherMath`).
- Treating a day with zero rain samples as "0.0 mm" — that conflates
  "no data" with "confirmed dry"; only ingest that actually observed zero
  should write zero.
- Confusing LoRain's interval rain (`rain_mm_delta` computed directly from
  a raw step count, no history lookup needed) with S2120's cumulative-counter
  delta (computed against the previous stored `rain_gauge_cumulative_mm` row,
  with explicit `first_sample`/`counter_reset`/`duplicate_timestamp` guards).
- Sending a bare `CLOSE` to a STREGA valve for any reason, including test
  cleanup — always use a short `OPEN_FOR_DURATION` or the cancel endpoint.
- Assuming the DRAGINO_LSN50 battery footer is always hidden because the
  device only reports `bat_v` — the voltage-derived fallback (issue #51)
  means it now shows a computed percentage; this contradicts older notes
  that predate that fix.

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

# irrigation_schedules trigger_metric CHECK (confirm P0 issue #92 status)
grep -n "trigger_metric" database/seed-blank.sql

# Dendrometer edge (v5) vs cloud (v6) ownership
grep -n "Dendrometer Analytics v5" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
sed -n '1,40p' docs/architecture/dendrometer-analytics-v6.md

# ET0 cloud-only implementation
grep -n "et0\|Et0" ../osi-server/backend/src/main/java/org/osi/server/analytics/WeatherMath.java  # sister-repo checkout required, path relative to this repo root

# Rain aggregation (S2120 cumulative-delta status machine; LoRain interval decoder)
grep -n "rainDeltaStatus" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
sed -n '1,130p' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js

# Battery footer fallback behavior (confirm issue #51 / bat_v fallback still present)
sed -n '1,55p' web/react-gui/src/components/farming/shared/deviceCardBattery.ts

# VWC not-implemented status
grep -n "VWC" web/react-gui/src/types/farming.ts docs/channel-manifest.md

# STREGA cancel endpoint + expectation table
grep -n "valves/:deveui/cancel" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
grep -n "CREATE TABLE valve_actuation_expectations" -A 20 database/seed-blank.sql
```

Cross-reference AGENTS.md's "Device catalog", "Chameleon calibration global
table", "Aqua-Scope LoRain", and "STREGA timed irrigation" sections — this
skill expands on those, it does not override them. If this skill and
AGENTS.md ever disagree, AGENTS.md wins; file an issue to reconcile rather
than silently trusting either.
