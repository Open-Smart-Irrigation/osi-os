# Standalone Agroscope Shadow Controller — Design Spec

**Status:** Approved design, not yet implemented.
**Date:** 2026-07-06
**Scope:** OSI Server (osi-server, cloud, Java/Spring). Compute-only shadow, additive, droppable.
**Sibling:** the v6-RDI shadow ([closed-loop-rdi-controller-design.md](closed-loop-rdi-controller-design.md), PR #49). This is the *third* comparison arm.

## Purpose

**Goal: behavioral parity with real deployed Agroscope systems.** OSI has the Agroscope irrigation code; we
implement the *same logic* so a zone under this controller behaves the same as an Agroscope-installed system.
It runs as a **standalone, parallel, compute-only shadow** in osi-server to enable a 3-way per-zone/day
comparison:

1. **v6 open-loop** — classify zone stress → percentage rule (production, drives actuation).
2. **v6-RDI shadow** — v6's `TWD_rel` into a corrected PI vs a mild-deficit setpoint (PR #49).
3. **Agroscope shadow** — a **faithful port** of Agroscope's own pipeline: global-cummax signed stress →
   SEM aggregation → PID → dose in mm (this spec).

**Nothing new actuates**; v6's open-loop recommendation still drives irrigation, unchanged.

## Faithfulness principle (read first)

The target is **the Agroscope code as it exists today** (kDrive `…/dendro_irrigation/backend/`), verified
line-by-line — *not* the older snapshot the [integration assessment](../../analysis/agroscope-irrigation-assessment/08-synthesis.md)
described. That verification found the assessment's "defects" are **not breaking**, so there is **no
`corrected` variant and no `fidelityMode` fork** — a single faithful port *is* the deliverable. Agroscope's
quirks are **reproduced, not fixed** (fixing them would break parity); they are documented in §"Reproduced
Agroscope behaviors." A **Python golden-master oracle** proves our numbers match Agroscope's.

## Locked decisions

| Decision | Choice |
|---|---|
| Structure | **Standalone**, parallel to the RDI shadow — own extractor, aggregator, controller, state, tables. Reuses PR #49's *patterns* (`REQUIRES_NEW` isolation, null-safety, orphan-safe upsert), not its code. |
| Fidelity | **Single faithful port** of the current Agroscope code. No corrected/legacy fork. Quirks reproduced + documented. |
| Runtime | **Java port**; the real Agroscope **Python is an offline golden-master oracle** (run once on a fixed dataset → fixture vectors). No Python in production. |
| Signal | Agroscope's **global-cummax signed stress** (`tree_stress_um`) from raw dendro. |
| Aggregation | **SEM-of-mean upper-95% CI** (`mean + 1.96·sd/√n`, `n=1 → mean`) — faithful, reproduced exactly. |
| Setpoint | `tree_daily_limit = −100 µm` (Agroscope `PID_DEFAULT_TREE_DAILY_LIMIT`); optional per-zone override. |
| Output | A **dose in mm**, clamped `[0, 10]`. Compute-only; no mm→duration, no actuation. |
| `cummax` anchoring | Persist a **per-tree historical-max high-water-mark** (equals Agroscope's full-history `cummax`, but retention-proof and O(1)). |
| Placement | Cloud-side; additive; opt-in per zone via `agroscope_shadow_enabled`. |

## Verified Agroscope constants (faithful defaults)

`Kp = 0.5`, `Ki = 0.1`, `Kd = 0.0` (derivative disabled), `max_water_mm_limit = 10.0`,
`tree_daily_limit = −100 µm`, `forecast_rain_skip = 2.0 mm` (`main.py:114-119`).

## Data source (corrected)

Raw dendro lives in **`sensor_data.data_json->>'dendro_position_mm'` (millimetres)** — the same source v6
uses via `SensorDataRepository.findDendroRawForPeriod` (`DendroAnalyticsService.java:252`). **Not**
`dendro_readings.position_um` (that entity exists but is unused by the extraction). Raw telemetry is **purged
at 365 days** (`TelemetryRetentionJob`, `raw-days:365`) — which is *why* the per-tree `cummax` must be
persisted (below), not recomputed from a retained window.

## Components

- **`AgroscopeStressExtractor`** — a device's raw `dendro_position_mm` window + its persisted historical-max →
  new daily `tree_stress_um`. Faithful port of `sensors_processing.py :: Baseline.dendro_processing`.
- **`AgroscopeAggregator`** — the zone's per-tree stress → `stress_upper95` via SEM-of-mean.
- **`AgroscopeWaterInput`** (helper) — daily measured `water_input_mm = zone_daily_environment.flow_liters /
  areaM2`, reusing OSI's already-implemented flow-meter aggregation (slice A is done). The Python oracle checks
  it against Agroscope's `watermeter_processing`; the raw sub-daily path is ported only on a material gap.
- **`AgroscopeController`** — faithful port of `actuators.py :: DendroIrrigationPID` (propose today / close next
  day), dose in mm vs the −100 µm setpoint.
- **`AgroscopeShadowService`** — `@Transactional(REQUIRES_NEW)` orchestration (extract → aggregate → close →
  rain-gate/propose → upsert), a sibling of `RdiShadowService`.

## Stress extraction (the #1 fidelity job)

Faithful to `dendro_processing`:

1. **Source/units:** `dendro_position_mm` (mm). The controller input is the *signed stress*, which is a
   **difference**, so the first-night normalization constant (`first_max`) **cancels** — we do **not** need to
   reproduce Agroscope's six `first_max` code paths. We **do** need its day-validity/NaN decisions (they
   change which days yield stress): the 0.25 V jump gate, `check_hourly_coverage` (values at shifted-hours
   15/16/17 **and** 22/23), the 3-day rolling 3σ outlier rejection, and noisy-day NaN-ing.
2. **Resample & interpolate:** 15-minute means, `interpolate(limit=5, limit_direction='both')`.
3. **Day boundary = 3-hour dawn offset:** group by `(timestamp − 3h).normalize()`.
4. **`tree_max_daily_value_um`** = max in the **22:00–23:59** window (end-of-day max); **min** = daily min.
   (Note: this differs from v6's `dMax` 05–07 / `dMin` 13–16 — **v6's extrema are NOT reusable.**)
5. **`historical_max` = `cummax(endMax)`** across all history — implemented as a **persisted per-tree
   high-water-mark**: `stress_D = endMax_D − historical_max_{D−1}`, then `historical_max_D = max(historical_max_{D−1}, endMax_D)`.
6. **NaN propagation:** a NaN day → NaN stress → a `skipped` day downstream.

**Timezone:** Agroscope stores naive-local in each sensor's own tz (UTC→tz via TimezoneFinder), so per-zone
day boundaries are **faithful** (not a deviation). The one trap is **DST**: naive-local `between_time` /
`normalize` are DST-fragile; a correct Java `ZoneId`/`Instant` port diverges from the oracle only on
DST-transition days → **generate oracle fixtures on DST-free date ranges.**

## Aggregation (SEM — reproduced faithfully)

Per zone/day, across trees with non-null stress (`main.py:178-192`):
`mean = AVG(stress)`, `sd` = sample stddev (0 when `n≤1`), `stress_upper95 = mean + 1.96·sd/√n` for `n>1`,
else `stress_upper95 = mean`. The controller consumes `stress_upper95`.

## Controller (faithful `DendroIrrigationPID`)

- **Error:** `e = tree_daily_limit − stress_upper95` (setpoint − observed; **opposite operand order to the RDI
  arm**, because stress polarity is inverted). Setpoint = −100 µm.
- **Output:** `raw = Kp·e + integral + Kd·(e − last_error)`; `dose_mm = clamp(raw − water_input_mm, 0, 10)`.
  (`Kd=0`, so the derivative term is inert.)
- **Propose (today):** compute `e_today`, `dose_mm`; store a `pending` cycle `{date, error_before=e_today,
  irrigation_mm=dose}`. **Integral unchanged at propose.**
- **Close (next day):** on the next day's `stress_upper95`, `e_next`; compute `next_target`; **anti-windup —
  integrate once only when `0 < next_target < max`:** `integral += Ki·e_next`; set `last_error = e_next`; mark
  the pending row `closed`.
- **Rain feed-forward:** if `forecast_rain > 2.0 mm`, force `dose_mm = 0`, store the pending cycle (with
  `error_before`) — faithful to Agroscope's rain skip.
- **`water_input_mm` (measured — reuse):** `water_input_mm = zone_daily_environment.flow_liters / areaM2` —
  OSI's already-implemented measured daily flow-meter volume (slice A is done; Dragino LSN50 count mode →
  `flow_liters`). Subtracted **before** the clamp/anti-windup gate, so it affects the *trajectory*, not just
  the level. **Always measured, never estimated;** a zone without a flow meter is not opted in. The Python
  oracle checks `flow_liters/areaM2` against Agroscope's `watermeter_processing` on a shared dataset; the raw
  sub-daily port is added **only if** the oracle shows a material gap (esp. the 03:00-offset day boundary /
  counter-reset). `COALESCE 0` only for a genuine data gap on an otherwise-metered zone.
- **Warm-restart:** per-zone `integral`/`last_error`/`pending_date` persisted; gains reloaded from state.

## Reproduced Agroscope behaviors (quirks — kept for parity, documented)

| Behavior | Verified in code | Effect | Why kept |
|---|---|---|---|
| Gain-reload: persisted gains override config on load | `actuators.py:267-271` | Config gain changes ignored while a state row exists | Only bites on retune; reproduce for parity |
| No `dt`/gap scaling: one integral step per close regardless of gap | `actuators.py:325-330` | Missing-data gaps treated as one day | Only bites on gaps; reproduce for parity |
| SEM tree-count coupling: more trees → tighter CI → more water; optimistic (least-deficit) bound | `main.py:190-192` | Dose depends on sensor count | Agroscope's actual behavior |
| Derivative disabled (`Kd=0`) | `main.py:116` | No trend term | Faithful |
| First error not integrated (integral starts at first *close*) | `actuators.py` propose vs update | One-time season-start transient | Benign; faithful |

## Data model (isolated shadow — droppable)

- **`irrigation_zones`**: `agroscope_shadow_enabled BOOLEAN NOT NULL DEFAULT false` +
  `agroscope_setpoint_override_um DOUBLE PRECISION NULL`.
- **`agroscope_tree_state`** (per tree/device): `device_id PK`, `historical_max_um`, `last_processed_date`,
  `updated_at` — the persisted per-tree `cummax` anchor.
- **`agroscope_shadow_state`** (per zone): `zone_id PK`, `integral`, `last_error`, `kp`, `ki`, `status`,
  `pending_date`, `updated_at` — PID warm-restart.
- **`agroscope_shadow_daily`** (per zone/date): `stress_upper95_um`, `stress_mean_um`, `stress_sd_um`,
  `n_trees`, `setpoint_um`, `setpoint_source` (`default|override`), `error`, `dose_mm`, `integral_after`,
  `forecast_rain_mm`, `water_input_mm`, `status` (`idle|pending|frozen|closed|skipped`), `created_at`,
  `UNIQUE(zone_id, date)`.
- Migration: next free date-based Flyway version (verify at implementation; the RDI arm uses `V2026_07_05_002`).

## Wiring & isolation

In `DendroAnalyticsService.computeForZone`, **after** the RDI-shadow block, guarded by
`zone.isAgroscopeShadowEnabled()`, call `AgroscopeShadowService.runShadow(...)` inside a try/catch that logs +
increments a failure counter. Inherited invariants (identical to the RDI shadow): **shadow-only** (no change
to v6 `ActionResult`/`irrigationAction`/actuation); **own `REQUIRES_NEW` transaction** so a shadow failure
can't roll back the shared `computeForAllZones` tx (real-bean poison test); **null/low-confidence safe**
(too-few trees or NaN stress → `skipped` no-op row, no NPE); **orphan-safe** (compare driven from committed v6
recs).

## 3-way comparison + the one metric

`GET /dendro/shadow/compare?zoneId&from&to` (admin-guarded), **date set driven from v6 recommendations** →
per date: v6 `irrigationAction` | RDI `adjustment` (+ `TWD_rel`) | Agroscope `dose_mm` (+ `stress_upper95`,
`n_trees`). Because the three outputs are on different scales, the endpoint also returns **one common metric —
each arm's next-day tracking error against its own setpoint** (did the tree sit near target?) — the
comparable yardstick, avoiding naive subtraction of the raw doses.

## Testing

- **Golden-master oracle (the parity proof):** an offline script (NOT in the prod path) runs the real
  `sensors_processing.dendro_processing` + `DendroIrrigationPID` on a fixed dendro dataset (DST-free range)
  and emits JSON fixtures committed under test resources. The Java extractor + controller must reproduce them
  within float tolerance.
- **Extractor:** `cummax`/HWM/`shift`/3h-day-boundary/end-of-day-max/NaN-day/jump-gate/coverage edge cases.
- **Aggregator:** SEM upper-95 value; `n=1 → mean`.
- **Water input:** `flow_liters/areaM2` vs Agroscope's `watermeter_processing` daily mm on the shared oracle
  dataset — assert within tolerance, else flag the raw sub-daily port.
- **Controller:** propose vs close, anti-windup gate `0 < target < max`, rain-freeze, warm-restart round-trip,
  gain-reload behavior, no-gap-scaling behavior (assert the *reproduced* behavior).
- **Isolation / poison / orphan:** mirror the RDI shadow (byte-identical v6 actuation; real-bean `REQUIRES_NEW`
  poison test; compare omits orphan rows).

## Out of scope

Actuating on the shadow; mm→duration; edge/firmware; dashboards; per-crop gain tuning; "correcting" any
Agroscope quirk.

## Caveats

- **Water-meter dependency.** Measured-water parity requires **slice A** (water-meter ingestion). This spec
  consumes A's channel; until A lands for a zone, that zone is not opted in (never a `water_input=0` estimate
  as a substitute for a real meter).
- **Open-loop in reality.** The shadow never actuates, so the stress it observes is driven by **v6's**
  watering; `dose_mm` is "the Agroscope dose *given v6's realized trajectory*," not a standalone closed loop
  (same caveat as the RDI arm).

## Affected components (cloud)

| Component | Change |
|---|---|
| Flyway migration | `agroscope_tree_state`, `agroscope_shadow_state`, `agroscope_shadow_daily`; two `irrigation_zones` columns |
| `IrrigationZone` | two fields |
| `AgroscopeStressExtractor` (new) | faithful global-cummax stress from raw `sensor_data` mm + per-tree HWM |
| `AgroscopeAggregator` (new) | SEM-of-mean upper-95 |
| `AgroscopeWaterInput` (small helper) | measured `flow_liters/areaM2`; oracle-verified vs `watermeter_processing` |
| `AgroscopeController` (new) + `AgroscopeState`/`AgroscopeResult` | faithful `DendroIrrigationPID` |
| `AgroscopeShadowService` (new) | `REQUIRES_NEW` orchestration + upsert |
| entities/repos for the three tables | persistence + warm-restart + per-tree HWM |
| `DendroAnalyticsService.computeForZone` | call the shadow for opted-in zones (try/catch); no actuation change |
| `DendroController` | `/dendro/shadow/compare` 3-way endpoint + tracking-error metric |
| test resources | Python-oracle fixtures + offline generator script |
