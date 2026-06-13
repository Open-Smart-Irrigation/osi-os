# Dendrometer Analytics v6 — Self-Calibrating & Robust

**Status:** Approved design, not yet implemented.
**Scope:** OSI Server (`osi-server`) `analytics` package — the default daily dendrometer scheduler analytics. Builds on the existing v5 structure; no rewrite.
**Date:** 2026-06-12

## Relationship to the Agroscope dendrometer controller

This design is **distinct** from the future opt-in `controller_mode='dendrometer'` described in
[agroscope-dendrometer-controller.md](agroscope-dendrometer-controller.md). That controller is edge-authoritative,
recommendation-only, and gated behind MeteoSwiss coverage. This v6 work improves the **existing cloud-side**
`DendroAnalyticsService` (the `DendroScheduler` daily job and `DendroController` manual trigger) that already runs for
every zone with dendrometer devices. The two can coexist; nothing here changes the Agroscope design or edge ingestion.

## Motivation

A review of the v5 implementation against the current literature (Peters et al. 2025, *New Phytologist*; Zweifel et al.
2016; apple-specific MDS/Ψstem studies) found the algorithm **structurally sound** — the stepwise zero-growth envelope
and the move away from `TWD/MDS_current` as the primary classifier are both correct. The remaining gaps are:

1. **Thresholds are absolute µm and uncalibrated.** They don't transfer across trunk sizes, sensor placements, or
   orchards, and there is no ground-truth link. (Field calibration via pressure bomb / Ψstem is **not available**; the
   system must self-calibrate from the dendrometer + weather data already collected.)
2. **Envelope anchors have no outlier guard** — a single spurious daily maximum permanently inflates TWD afterward.
3. **Extrema windows are fixed clock hours** (05–07h pre-dawn, 13–16h afternoon) that ignore seasonal/latitude drift in
   sunrise and solar noon across sites spanning equatorial to temperate.
4. **Confidence gating is inconsistent** — `dataQuality="insufficient"` (sparse days) does not actually prevent a tree
   from driving the zone irrigation decision; the floor `MIN_SAMPLES_DAY = 5` is far below the expected daily volume.
5. **Recovery and VPD logic re-import `MDS_current`/`MDS_ref`** criteria that the v5 classifier was redesigned to avoid.

Out of scope (deferred by decision): a regulated-deficit-irrigation (RDI) water-saving strategy, and fitting a Ψstem
logistic model (infrastructure stub only).

## Design

### 1. Self-calibrated normalization (the scientific core)

Classification moves from absolute `TWD_day` (µm) to a dimensionless, self-calibrated ratio:

```
TWD_rel = TWD_day / A_ref
```

- **`A_ref`** is a per-tree, well-watered **reference amplitude**. We reuse the existing
  `DendroBaseline.mdsMaxReferenceUm` (already the 90th-percentile MDS over good-confidence baseline days) as `A_ref`.
  No new baseline column is required; the field gains a documented, load-bearing role.
- **Why this is sound where `TWDnorm` was not:** the denominator is a **fixed baseline value**, computed once during the
  well-watered baseline period. It does **not** collapse under stress (the failure mode of using *current* MDS as a
  denominator). This is the Peters TWDnorm idea applied correctly, and it is fully self-calibrating from existing data.
- **Transferability:** because `A_ref` scales with each tree's trunk size and sensor sensitivity, ratio thresholds
  transfer across trunk ages and orchards without per-site hand-tuning.
- **Graceful warm-up:** when the baseline is incomplete (`A_ref` null, ~first 14 good days), classification falls back to
  the absolute-µm thresholds — i.e. **exactly current v5 behavior** — until the tree self-calibrates.
- **Persistence:** add `dendro_daily.twd_rel` (additive column) for display/debug. `tree_state_v5` semantics preserved.

### 2. Externalized, calibration-ready thresholds

Replace the hardcoded `DendroCalibration` built-ins with a DB-backed lookup:

- New server table **`dendro_calibrations`**: `key` (PK), `crop`, `twd_method`, ratio thresholds
  (`mild`/`moderate`/`significant`/`severe` as multiples of `A_ref`), absolute-µm fallback thresholds (used during
  warm-up), and nullable `psi_a` / `psi_b` (future ground-truth hook, unused now).
- Seeded by a Flyway migration from the **current built-in values** (existing µm thresholds become the warm-up fallback;
  ratio defaults are seeded as sensible literature-informed starting points, documented as tunable).
- `DendroCalibration.forKey` becomes a repository lookup with the **current in-code built-ins retained as fallback** when
  the table is empty or the key is missing → zero regression risk if the table is unseeded.
- `irrigation_zones.calibration_key` continues to select the row. Admins can tune per-crop thresholds without redeploy.

### 3. Robustness fixes

- **(a) Envelope-anchor outlier guard.** In `EnvelopeTwd.compute`, a day may establish a new envelope anchor only if it
  is good-confidence **and** its `dMax` is within a plausible growth-rate bound versus the previous anchor. Implemented
  via a per-point `anchorEligible` flag plus a max-growth-rate guard; rejected spikes do not move the reference.
- **(b) Solar-geometry extrema windows.** Derive the pre-dawn and afternoon windows from the zone's latitude/longitude
  using a small in-code NOAA solar-position utility (no new dependency). Pre-dawn tracks sunrise; afternoon tracks
  solar-noon + offset. Fall back to the fixed 05–07h / 13–16h windows when latitude/longitude are missing. The full-day
  fallback for empty windows is retained.
- **(c) Confidence gating fix.** Unify the two quality notions: `dataQuality="insufficient"` forces
  `lowConfidence = true`, so sparse days cannot drive the zone decision. Raise the sample floors
  (`MIN_SAMPLES_DAY`, window minimums) to defensible values tied to the expected uplink cadence.
- **(d) Recovery / VPD consistency.** Replace the `mdsNorm` / `MDS_ref` criteria in `updateRecoveryVerification` and
  `applyVpdStressAdjustment` with `TWD_rel`-based criteria (e.g. recovery passes when `TWD_rel` is below the mild
  threshold and trending down over N days), consistent with the new classifier.

### 4. Companion config item — LSN50 sensor warm-up (osi-os, not firmware)

A 3-second sensor warm-up (powering the ratiometric dendrometer excitation and letting it settle before the ADC samples)
reduces the noise / step artifacts that the server's 200 µm jump-removal currently corrects — better raw signal at the
source. **This is a configuration value, not a firmware change.** The feature already exists end-to-end in
`web/react-gui/src/components/farming/DraginoSettingsModal.tsx` via `lsn50API.setFiveVoltWarmup(deveui, ms)` (the LSN50
`5VT` external-sensor power-time downlink).

- **Action:** set the LSN50 5V warm-up to **3000 ms** on dendrometer-mode devices via the existing downlink path.
- **Optional enhancement:** pre-fill 3000 ms as the recommended default for dendrometer-mode LSN50s in the settings
  modal. Small, isolated osi-os UI change; tracked separately from the server analytics work.

### 5. Backward compatibility & rollout

- **Additive only.** New `dendro_daily.twd_rel` column and `dendro_calibrations` table. All existing columns remain
  populated; `tree_state_v5` semantics preserved.
- **Every new path degrades to current behavior:** null `A_ref` → absolute thresholds; null lat/long → fixed windows;
  empty calibration table → in-code built-ins.
- **Backfill** via the existing `DendroController` manual recompute trigger.

### 6. Testing (TDD)

- Extend `DendroAnalyticsScenarioTest`, `DendroAnalyticsRecomputeRegressionTest`, `DendroCalibrationTest`, and the
  `EnvelopeTwd` tests.
- New unit tests: solar-window utility; anchor outlier guard; normalization + warm-up fallback;
  DB threshold lookup + built-in fallback; recovery-on-relative-TWD.

## Affected components

| Component | Change |
|-----------|--------|
| `DendroAnalyticsService` | normalization, confidence gating, recovery/VPD criteria, solar windows wiring |
| `EnvelopeTwd` | anchor-eligibility + growth-rate guard |
| `DendroCalibration` | DB-backed lookup with in-code fallback; ratio + fallback thresholds |
| `DendroBaseline` | `mdsMaxReferenceUm` documented as `A_ref` |
| `DendroDaily` + migration | `twd_rel` column |
| new `dendro_calibrations` table + repo + Flyway seed | externalized thresholds |
| new solar-position utility | extrema windows |
| `DraginoSettingsModal` (osi-os, optional) | 3000 ms warm-up default |

## Open items for plan stage

- Exact ratio-threshold defaults per crop (apple first) and the warm-up-fallback µm values (keep current v5 values).
- Numeric values for the growth-rate guard and the raised sample floors (tie to confirmed uplink cadence).
- Solar-window offsets relative to sunrise / solar-noon.
