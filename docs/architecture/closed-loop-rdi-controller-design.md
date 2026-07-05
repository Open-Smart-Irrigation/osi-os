# Closed-Loop RDI Controller for Dendro v6 (Shadow) — Design Spec

**Status:** Approved design, not yet implemented.
**Date:** 2026-07-05
**Scope:** OSI Server (osi-server, cloud, Java/Spring) — the dendro v6 analytics. Cloud-only, shadow/compute-only, additive.

## Purpose

v6 has the better *signal* (stepwise-envelope `TWD_rel`, per-crop calibration, MAD+75th-pct aggregation,
solar windows, confidence gating), but its *decision engine* is **open-loop**: it classifies today's zone
stress into a level and applies a fixed percentage rule (`increase_10/20 / maintain / decrease / emergency`),
with no memory of whether yesterday's water actually moved the tree.

This adds a **closed-loop controller** as a parallel *shadow* decision path: a corrected PI controller that
holds the zone at a deliberate mild-deficit **RDI setpoint** and self-corrects from the tree's measured
next-day response. It is the P0 enhancement from the [Agroscope integration assessment](../../analysis/agroscope-irrigation-assessment/08-synthesis.md)
(§5): OSI's superior signal + Agroscope's superior control paradigm.

**Shadow-first, 2-way:** the controller computes a recommendation *alongside* v6's existing open-loop one,
per zone/day; **v6's existing recommendation still drives actuation, unchanged; nothing new actuates.** Both
outputs are persisted for comparison. This delivers the enhancement *and* the empirical data to answer "does
closed-loop + RDI hold the tree at target with less water than the open-loop rules?" before anyone flips it on.

## Locked decisions

| Decision | Choice |
|---|---|
| Paradigm | Closed-loop **PI** (P + I, no D — signal too noisy for D; Agroscope drops it too), daily cadence. |
| Signal | v6's existing continuous zone-aggregated `TWD_rel` (75th-pct across non-ref trees). No new signal. |
| Comparison | **2-way shadow:** current open-loop v6 vs new v6-closed-loop-RDI, both on `TWD_rel`. Compute-only; no actuation, no edge changes. |
| Output | A continuous recommended water-volume adjustment (the smooth analogue of v6's `increase_X% / decrease_X%`). |
| RDI setpoint | **Hybrid:** default derived from v6's per-crop DB calibration + phenology (target the *mild* deficit band); optional per-zone `rdi_target_override`. |
| Controller correctness | The **corrected** controller — bake in the fixes the Agroscope analysis found (see §"Control law"). |
| Placement | Cloud-side (v6 is server-side); additive; opt-in per zone via a flag. |

## Where it plugs into v6

`DendroAnalyticsService.computeForZone(...)` already computes the zone-aggregated `TWD_rel` and calls the
open-loop `irrDecision(...) → ActionResult` (which still drives the persisted recommendation + actuation).
We add, **after** that and only when the zone opts in:

1. `RdiController.decide(zone, observedTwdRel, setpoint, forecastRainMm, lowConfidence, state)` → an
   `RdiResult` (recommended adjustment + controller internals).
2. Persist the shadow result to a new `dendro_rdi_daily` row and update the per-zone `dendro_rdi_state`.
3. **Do not** modify the `ActionResult`, `ZoneDailyRecommendation.irrigationAction`, schedule policy, or any
   actuation path.

## Control law (corrected PI)

Daily, per opted-in zone:

- **Error:** `e = observedTwdRel − setpoint` (drier than target → `e > 0` → more water; wetter → `e < 0` → less).
- **Output:** `adjustment = clamp(Kp·e + integral, −maxAdj, +maxAdj)` — a continuous water-volume adjustment.
- **Feed-forward:** subtract expected rain (decision-time forecast-rain snapshot from the per-zone weather
  source merged in the weather-foundation work); on significant forecast rain, freeze the controller (no
  integral update) and recommend no increase.
- **Two-phase next-day feedback:** propose today → next day observe whether `TWD_rel` moved toward the
  setpoint → update the integral. This is the closed loop.
- **Corrected against Agroscope's PID defects** (from the assessment [P6]):
  - integrate the **first** error (Agroscope skipped it);
  - **no double-integration** — the integral advances exactly once per closed cycle;
  - **proper anti-windup** — integral accrues only when the output is unsaturated (`−maxAdj < raw < +maxAdj`);
  - **dt / gap handling** — scale or **skip** integration across missing or low-confidence days (reuse v6's
    `lowConfidence`); never treat non-adjacent days as adjacent;
  - **explicit gain precedence** — config/DB gains, never silently DB-overrides-config;
  - **surfaced (not swallowed) errors** on persistence;
  - keep the one thing Agroscope got right — **warm-restart** (a pending row carries pre-update state, a
    closed row post-update).

Gains (`Kp`, `Ki`, `maxAdj`, rain-skip threshold) are global defaults (env/DB, mirroring v6's calibration
pattern), tunable; per-crop gains are a later refinement.

## RDI setpoint (hybrid)

`setpoint = rdi_target_override` if set on the zone; else derived: the *mild* relative threshold from the
zone's `DendroCalibration.stressThresholdsRelative().mild()` scaled by the phenological modifier — i.e. aim
for the top of the mild-deficit band, tightening in sensitive stages and relaxing in tolerant ones.

## Data model (isolated shadow — droppable)

- **`dendro_rdi_state`** (one row per zone): `integral`, `last_error`, `kp`, `ki`, `status`, `updated_at` —
  warm-restart, mutated daily. Isolated from the production `ZoneIrrigationState`.
- **`dendro_rdi_daily`** (per zone/date): `observed_twd_rel`, `setpoint`, `error`, `adjustment`,
  `integral_after`, `forecast_rain_mm`, `low_confidence`, `status`, `setpoint_source` (`derived|override`) —
  the shadow output + internals, for comparison against `ZoneDailyRecommendation` on the same date.
- **`irrigation_zones`**: `rdi_shadow_enabled BOOLEAN DEFAULT false` (opt-in) + `rdi_target_override DOUBLE
  PRECISION NULL` (hybrid setpoint override).

## Comparison harness

Per zone/day, both outputs are queryable: v6's `ZoneDailyRecommendation.irrigationAction` (+ implied volume)
vs `dendro_rdi_daily.adjustment`, alongside the realized zone `TWD_rel` (did the tree stay near the setpoint?)
and actual water applied. A read endpoint / view exposes the side-by-side for evaluation. (Detailed
visualization is out of scope for this spec — the data is persisted; a minimal compare endpoint is in scope.)

## Testing

- **PI math** unit tests: first-error integration, no double-integration, anti-windup at saturation,
  gap/low-confidence integration scaling/skip, clamp — the exact things Agroscope got wrong.
- **Setpoint** derivation (per-crop/phenology) + override precedence.
- **Warm-restart** round-trip (state persisted/reloaded across runs).
- **Isolation guard:** the shadow path does NOT change v6's `ActionResult` / persisted `irrigationAction` /
  actuation — a regression test asserting an opted-in zone's actuated recommendation is identical to before.
- **Opt-out default:** a zone with `rdi_shadow_enabled=false` computes no shadow (no `dendro_rdi_daily` row).

## Out of scope

Actuating on the shadow (a later, opt-in phase); edge changes; the full Agroscope global-cummax signal
(3-way comparison — deferred); rich comparison dashboards; per-crop gain tuning.

## Affected components (cloud)

| Component | Change |
|---|---|
| Flyway migration | `dendro_rdi_state`, `dendro_rdi_daily` tables; `irrigation_zones.rdi_shadow_enabled` + `rdi_target_override` |
| `IrrigationZone` | two fields |
| `RdiController` (new) + `RdiResult`/`RdiState` | the corrected PI control law |
| `DendroAnalyticsService.computeForZone` | invoke the controller for opted-in zones; persist shadow; do not touch actuation |
| repos/entities for the two new tables | persistence + warm-restart |
| a minimal compare read endpoint | side-by-side per zone/day |
