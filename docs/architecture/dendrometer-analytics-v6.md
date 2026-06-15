# Dendrometer Analytics v6

**Status:** Implemented (osi-server). Cloud-side daily analytics; the edge UI is not yet a consumer (see *Boundaries*).

## What it is

Dendrometers measure micrometre-scale swelling and shrinking of a tree's stem. The diurnal pattern
encodes water status: a well-watered tree rehydrates overnight and shrinks under daytime transpiration.
v6 turns that signal into a daily per-tree stress level and a zone irrigation recommendation.

It is an evolution of v5, not a rewrite. v5 already used the right backbone — a stepwise "zero-growth"
envelope of stem maxima to derive **Tree Water Deficit (TWD)**. v6 fixes the parts that made that signal
hard to act on: thresholds that didn't transfer between trees, brittle data handling, and a couple of
internal inconsistencies.

## The core idea: self-calibrated deficit

The problem with classifying on raw TWD in micrometres is that it doesn't transfer. A 130 µm deficit on a
young high-density trunk means something very different than on a mature one, and the obvious normaliser
(daily shrinkage) *collapses* under severe stress — exactly when you need it.

v6 normalises against a **fixed, well-watered baseline amplitude** `A_ref` (computed once, during the
tree's baseline period) and classifies on the dimensionless ratio:

```
TWD_rel = TWD_day / A_ref
```

Because the denominator is a stored baseline value, it doesn't move under stress. The result is
comparable across trunk sizes and orchards, and a single per-crop threshold set transfers between trees.
Until a tree has a baseline (~14 good days), classification falls back to the old absolute-µm thresholds —
so new trees behave exactly as in v5 until they self-calibrate.

## How a day is computed

1. Load the day's 10-minute stem positions; filter and de-jump them.
2. Extract the pre-dawn maximum and afternoon minimum using **sun-aware windows** derived from the zone's
   latitude/longitude (falling back to fixed clock hours when coordinates are missing).
3. Update the **TWD envelope**. A day only raises the reference if it's good-quality and its growth is
   physically plausible — so sensor spikes and low-confidence days can't inflate the deficit baseline.
4. Compute `TWD_rel` and classify into none / mild / moderate / significant / severe, adjusted by
   phenological stage and evaporative demand (VPD).
5. Aggregate trees to a zone (outlier-filtered) and emit an irrigation recommendation, with rain
   suppression and recovery-verification guards.

## Confidence gating

Sparse days are dangerous: a handful of readings can fake an extreme. v6 sets one floor for *computing*
extremes (≥30 readings) and a higher floor for *driving irrigation* (≥60). Below 60, a day is
low-confidence and propagates the last good state instead of acting. This is an intentional change from
v5, where thin days could still steer irrigation. Baseline accumulation is unaffected — it already
ignored low-quality days.

## Calibration

Per-crop thresholds live in a `dendro_calibrations` table and can be tuned without a redeploy; the
in-code defaults are the fallback when the table is unseeded. **The shipped thresholds are
literature-informed starting points, not field-calibrated values** — they should be validated against
real irrigation response per site. The schema reserves a hook for a future stem-water-potential model
once pressure-bomb data is available.

## Boundaries

This analytics runs **server-side** (a daily scheduled job plus an admin-triggered recompute). The stress
level and recommendation are persisted and carried across the edge↔cloud sync; the raw `TWD_rel`
diagnostic is stored and exposed in the recommendation payload but not yet surfaced in the on-device
dendrometer UI, which reads edge-local data. Bringing v6 to the edge UI is deferred follow-up, not part
of this work.

## Companion changes

- **LSN50 warm-up default:** dendrometer devices default to a 3 s sensor warm-up (existing downlink), so
  the probe settles before the ADC samples — fewer raw-signal artifacts to clean up downstream.
- **`unknown` stress handling:** the dashboard renders an `unknown` stress level (emitted for
  low-confidence days) as a neutral "Unknown" badge instead of crashing.

## Known follow-ups

- Field-calibrate the per-crop thresholds (and the envelope growth-rate guard) against real orchards.
- Surface `TWD_rel` in the on-device UI / decide whether v6 should also run on the edge.
