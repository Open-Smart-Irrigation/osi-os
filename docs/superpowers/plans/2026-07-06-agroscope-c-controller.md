# Agroscope Slice C — Faithful Shadow Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A faithful Java port of Agroscope's dendro pipeline (global-cummax signed stress → SEM aggregation → PID dose-in-mm) as a compute-only shadow in osi-server, for the 3-way comparison.

**Architecture:** Mirrors the RDI shadow (PR #49): a `REQUIRES_NEW` `AgroscopeShadowService` invoked from `DendroAnalyticsService.computeForZone` after the RDI block, guarded by `agroscope_shadow_enabled`, writing isolated `agroscope_*` tables. Faithful to the real Agroscope code (`sensors_processing.py`, `actuators.py`, `main.py`); a Python golden-master oracle proves parity. **No `fidelityMode` fork** — single faithful port; Agroscope's quirks are reproduced.

**Tech Stack:** Java 21, Spring Boot, JPA, Flyway (Postgres), Lombok, JUnit5 + AssertJ + Mockito; Python 3 (offline oracle only). Build/test from `osi-server/backend`: `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend`.

## Global Constraints
- Spec: [agroscope-shadow-controller-design.md](../../architecture/agroscope-shadow-controller-design.md). Overview: [agroscope-integration-overview.md](../../architecture/agroscope-integration-overview.md).
- **Branch off `feat/rdi-shadow-controller`** (the RDI shadow this mirrors is unmerged, PR #49). If #49 merges first, rebase onto `main`. Commit per task.
- **Shadow only:** never change v6's `ActionResult` / `ZoneDailyRecommendation.irrigationAction` / schedule / actuation (isolation regression test; byte-identical).
- **Transaction isolation:** shadow persists in `AgroscopeShadowService` `@Transactional(REQUIRES_NEW)`, called in try/catch + failure counter — a shadow failure must not roll back the shared `computeForAllZones` tx (real-bean poison test).
- **Faithful constants** (`main.py:114-119`): `Kp=0.5`, `Ki=0.1`, `Kd=0`, `maxDoseMm=10.0`, `setpointUm=-100`, `rainSkipMm=2.0`. Error `e = setpointUm − stressUpper95` (setpoint − observed — **opposite operand order to the RDI arm**). Output `clamp(Kp·e + integral − waterInputMm, 0, maxDoseMm)`. Integral advances **only** in the next-day close, gated `0 < nextTarget < maxDoseMm`.
- **Reproduce quirks, don't fix:** gain-reload (persisted `kp/ki` override config on load), no `dt`/gap scaling (one integral step per close), SEM tree-count coupling. **Units:** work in **µm** — `positionUm = dendro_position_mm × 1000` — so the −100 setpoint and all Agroscope constants apply directly.
- Measured water only: `waterInputMm` from slice A's `AgroscopeWaterInput` (`flow_liters/areaM2`); a zone without `areaM2` is not opted in. **Documented deviation (I2):** in *deployed* Agroscope the PID's `total_water_input` is a dead path (never persisted — the `watermeter_processing` renames are index no-ops), so real installs run with `water_input = 0` always. Feeding measured flow is the PID's documented parameter and the right engineering, but it is a **deliberate improvement over deployed behavior**, not a reproduced quirk — the oracle validates the *mechanism* (dose = raw − water) faithfully.
- Status vocab (`agroscope_shadow_daily.status` / `agroscope_shadow_state.status`): `idle | pending | frozen | closed | skipped`.

## File structure
| File | Action |
|---|---|
| `db/migration/V2026_07_06_001__agroscope_shadow.sql` | Create (3 tables + 2 zone columns) |
| `zone/IrrigationZone.java` | Modify (`agroscopeShadowEnabled`, `agroscopeSetpointOverrideUm`) |
| `analytics/AgroscopeStressExtractor.java` (+ `TreeStressResult`) | Create (global-cummax stress, HWM) |
| `analytics/AgroscopeAggregator.java` (+ `ZoneStress`) | Create (SEM upper-95) |
| `analytics/AgroscopeController.java` (+ `AgroscopeState`/`AgroscopeResult`) | Create (faithful PID) |
| `analytics/AgroscopeTreeState.java` + repo, `AgroscopeShadowState.java` + repo, `AgroscopeShadowDaily.java` + repo | Create (persistence — mirror the `DendroRdi*` files) |
| `analytics/AgroscopeShadowService.java` | Create (`REQUIRES_NEW` orchestration) |
| `analytics/DendroAnalyticsService.java` | Modify (invoke shadow after RDI block) |
| `analytics/DendroController.java` | Modify (`/dendro/shadow/compare` 3-way + tracking error) |
| `src/test/resources/agroscope/oracle/*.json` + `tools/agroscope_oracle.py` | Create (golden-master fixtures + generator) |

---

## Resolved design decisions (fable-reviewed) — read before Tasks 3, 7, 10

**Cleaning-domain reconciliation.** Classify Agroscope's cleaning by whether it is truly voltage-bound:
- **Reproduce in Java on the µm series (required for parity):** (1) `check_hourly_coverage` — pure *time*-coverage (data present at shifted hours {15,16,17} AND {22,23}; `sensors_processing.py:121-127`), applied both as the per-day gate and re-applied on the resampled series; it decides NaN days → NaN stress → PID skip. (2) NaN propagation exactly, incl. the cummax-shift rule (Task 3 B1) and skipped days occupying a calendar slot as NaN (poisoning the next day). (3) 15-min mean resample + linear interpolate limit 5 both directions.
- **Satisfy via osi-server validity (do NOT port):** the 0 V zero-drop and manual `dendro_jumps_dates` → replaced by filtering `dendro_valid == 1`. Do **not** drop `position_mm == 0.0` (wrong domain).
- **Defer behind a documented divergence (port later only on field evidence):** the 0.25 V day-span jump gate + 3-day 3σ outlier NaN-ing (`:141-190`). The 3σ is affine-invariant (µm = a·V+b selects the identical points) → portable in µm later; the span gate maps to `0.25 × sensorLength_mm × 1000 / Vref` µm. Both only fire on electrical-fault days OSI's edge QA already flags invalid. **On clean data every deferred step is a no-op**, so the clean-range oracle still exercises the whole live path; record fault days via the daily row's `low_confidence`/status for visibility.

**Oracle input comparability.** Do NOT feed the µm series into Agroscope's extractor directly (its cleaning would see µm where it expects volts and flip every day into the jump branch). Exploit that Agroscope's conversion is affine and stress is a difference: in `tools/agroscope_oracle.py` **synthesize the voltage fixture from the µm series** — pick `g = sensor_length·1000/voltage_reference` (e.g. `sensor_length=15.0, voltage_reference=3.0 → g=5000 µm/V`) and `V0`, set `V(t) = position_mm(t)·1000/g + V0` (V0 so values sit in ~(0.5 V, Vref)). Then Python's internal µm ≡ Java's `position_mm×1000` up to a constant that **cancels in `stress = endMax − cummax.shift(1)`**. **Assert only on `tree_stress_um` and downstream (`stress_upper95_um`, `dose_mm`, `integral_after`); never on absolute `tree_max_daily_value_um`/HWM** (they differ by the constant). Tolerance `1e-3` relative. See Task 10 for the fixture spec + the 6 required cases.

## Task 1: Migration
- [ ] Create `V2026_07_06_001__agroscope_shadow.sql`:
```sql
-- Agroscope faithful shadow controller. Isolated, additive, droppable.
ALTER TABLE irrigation_zones ADD COLUMN IF NOT EXISTS agroscope_shadow_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE irrigation_zones ADD COLUMN IF NOT EXISTS agroscope_setpoint_override_um DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS agroscope_tree_state (
    device_id          BIGINT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    historical_max_um  DOUBLE PRECISION,   -- running cummax of end-of-day max
    last_end_max_um    DOUBLE PRECISION,   -- previous day's endMax (null if that day was NaN) — for stress=endMax - cummax.shift(1)
    last_processed_date DATE,
    updated_at         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agroscope_shadow_state (
    zone_id      BIGINT PRIMARY KEY REFERENCES irrigation_zones(id) ON DELETE CASCADE,
    integral     DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_error   DOUBLE PRECISION,
    kp           DOUBLE PRECISION NOT NULL,
    ki           DOUBLE PRECISION NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'idle',
    pending_date DATE,
    updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agroscope_shadow_daily (
    id                BIGSERIAL PRIMARY KEY,
    zone_id           BIGINT NOT NULL REFERENCES irrigation_zones(id) ON DELETE CASCADE,
    date              DATE NOT NULL,
    stress_upper95_um DOUBLE PRECISION,
    stress_mean_um    DOUBLE PRECISION,
    stress_sd_um      DOUBLE PRECISION,
    n_trees           INT,
    setpoint_um       DOUBLE PRECISION,
    setpoint_source   VARCHAR(12),           -- default | override
    error             DOUBLE PRECISION,
    dose_mm           DOUBLE PRECISION,
    integral_after    DOUBLE PRECISION,
    forecast_rain_mm  DOUBLE PRECISION,
    water_input_mm    DOUBLE PRECISION,
    low_confidence    BOOLEAN NOT NULL DEFAULT false,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',   -- idle|pending|frozen|closed|skipped
    created_at        TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT uq_agro_daily UNIQUE (zone_id, date)
);
```
- [ ] `./gradlew compileJava` → SUCCESS. Commit `feat(agroscope): migration — shadow tables + zone flags`.

## Task 2: `IrrigationZone` fields
- [ ] Add (mirror the `rdiShadowEnabled` fields added in PR #49):
```java
    @Column(name = "agroscope_shadow_enabled", nullable = false)
    @Builder.Default private boolean agroscopeShadowEnabled = false;

    @Column(name = "agroscope_setpoint_override_um")
    private Double agroscopeSetpointOverrideUm;
```
- [ ] Compile. Commit `feat(agroscope): IrrigationZone shadow flag + setpoint override`.

## Task 3: `AgroscopeStressExtractor` (the #1 fidelity job)
Faithful to `sensors_processing.py::dendro_processing` per the resolved decisions above. The **caller** (Task 7)
supplies the correct 03:00→03:00 window and cold-start backfill; this pure extractor just processes the entries.

**Interfaces:**
- Consumes: `List<SensorDataRepository.DendroRawEntry>` (`recordedAt` Instant, `positionMm`; **already `dendro_valid==1`** from `findDendroRawForPeriod`); the zone `ZoneId`; the persisted `AgroscopeTreeState` (`historicalMaxUm`, `lastEndMaxUm`, `lastProcessedDate` — all nullable on first run).
- Produces: `record TreeStressResult(LocalDate date, Double treeStressUm, Double endMaxUm, Double newHistoricalMaxUm, Double newLastEndMaxUm)` per newly-processed day, plus the final HWM/lastEndMax/lastProcessedDate.

- [ ] **Step 1: Write failing tests** (`AgroscopeStressExtractorTest`): (a) `endMax` is the max over the **22:00–23:59 local** window (not the raw daily max); (b) `stress = endMax_D − historicalMax_{D−1}`; (c) `historicalMax` monotone non-decreasing; (d) new-peak day `stress > 0`, deficit day `stress ≤ 0`; (e) warm-restart: a persisted `historicalMaxUm`/`lastEndMaxUm` from a prior run is used, no full recompute; (f) **NaN-day (B1):** a no-coverage day → `treeStressUm == null`, **AND the next fully-covered day also has `treeStressUm == null`** (cummax.shift(1) picked up the NaN), while `historicalMax` still advances correctly; (g) units: `position_mm → endMaxUm` ×1000; (h) **3h dawn boundary (I6c):** a point at 01:30 local is grouped into the **previous** calendar day.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Core:
```java
// 1. positionUm = positionMm * 1000.0. Do NOT drop zeros (wrong domain; entries are already dendro_valid==1).
// 2. Resample to 15-min means; interpolate linear limit=5, both directions.
// 3. dayOf(instant) = instant.atZone(zoneId).minusHours(3).toLocalDate();      // 3h dawn offset
// 4. coverage(day): points present at shifted hours {15,16,17} AND {22,23} (== wall 18-20:59 AND wall 01-02:59 of D+1).
//    endMax(day) = covered ? max(value) over local [22:00, 23:59:59] : null;   // NaN day when not covered
// 5. Walk days ascending over the window:
//      hwmPrev  = state.historicalMaxUm;   lastEndMax = state.lastEndMaxUm;    // null on first ever
//      // B1: stress is null unless BOTH today and *yesterday* had a value (yesterday non-null => cummax_{D-1} == hwmPrev exactly)
//      stress   = (endMax != null && lastEndMax != null && hwmPrev != null) ? endMax - hwmPrev : null;
//      hwmNew   : use an explicit if/else — a nested ternary NPEs in Java (it unifies to primitive
//                 double and unboxes the null Double branch): if(endMax==null) hwmNew=hwmPrev;
//                 else if(hwmPrev==null) hwmNew=endMax; else hwmNew=Math.max(hwmPrev,endMax);
//      emit TreeStressResult(day, stress, endMax, hwmNew, endMax);            // newLastEndMax = today's endMax (may be null)
//      hwmPrev = hwmNew; lastEndMax = endMax;
// 6. Return results + final hwm/lastEndMax + lastProcessedDate = last day in window.
```
Use a small `NavigableMap<Instant,Double>` + linear interpolation with a 5-bucket gap limit (or reuse a v6 bucketing helper if one exists — verify signature first).
- [ ] **Step 4:** Run → PASS. Commit `feat(agroscope): global-cummax stress extractor (persisted HWM, NaN-shift faithful)`.

## Task 4: `AgroscopeAggregator` (SEM upper-95)
- [ ] **Step 1: Failing tests:** (a) `upper95 = mean + 1.96·sd/√n` for a multi-tree set with known mean/sd; (b) `n=1 → upper95 = mean` (the single value); (c) empty / all-null → `n=0`, `upper95 = null`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** `ZoneStress aggregate(List<Double> perTreeStressUm)`:
```java
record ZoneStress(Double upper95Um, Double meanUm, Double sdUm, int n) {}
// drop nulls; n = count; if n==0 return (null,null,null,0)
// mean = avg; sd = sample stddev (n>1 else 0.0); half = n>1 ? 1.96*sd/Math.sqrt(n) : 0.0
// upper95 = mean + half
```
- [ ] **Step 4:** PASS. Commit `feat(agroscope): SEM-of-mean upper-95 aggregation`.

## Task 5: `AgroscopeController` (faithful `DendroIrrigationPID`)
**Interfaces:** `record AgroscopeState(double integral, Double lastError, double kp, double ki, String status, LocalDate pendingDate)`; `record AgroscopeResult(double doseMm, Double error, double integralAfter, String status)` (`error` nullable — null on `skipped`).
- [ ] **Step 1: Failing tests** (`AgroscopeControllerTest`): (a) `e = setpointUm − stressUpper95`; (b) `dose = clamp(Kp·e + integral − waterInputMm, 0, 10)`; (c) **propose does NOT change the integral**; (d) **close integrates once**, `integral += Ki·e_next`, gated `0 < nextTarget < 10`; (e) close with a saturated `nextTarget` (≥10 or ≤0) does **not** integrate (anti-windup); (f) rain-freeze proposal → `dose=0`, `status=frozen`; (g) gain-reload: constructing with config gains but loading a state with different `kp/ki` uses the **state's** gains (reproduced quirk); (h) no gap scaling: a close after a 3-day gap still integrates exactly one `Ki·e` step (reproduced quirk); (i) null/low-confidence observed → `skipped` no-op, integral unchanged, no NPE.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** faithful to `actuators.py`:
```java
double buildDose(double e, double waterInputMm, AgroscopeState s) {          // _build_output_from_error
    double raw = s.kp() * e + s.integral();                                  // Kd=0 → no d-term
    return Math.max(0.0, Math.min(raw - waterInputMm, MAX_DOSE_MM));
}
AgroscopeResult propose(Double stressUpper95, double setpoint, double forecastRainMm,
                        boolean lowConf, double waterInputMm, AgroscopeState s) {
    if (stressUpper95 == null || lowConf) return new AgroscopeResult(0, null, s.integral(), "skipped");
    double e = setpoint - stressUpper95;                                     // setpoint − observed
    if (forecastRainMm > RAIN_SKIP_MM) return new AgroscopeResult(0, e, s.integral(), "frozen");
    return new AgroscopeResult(buildDose(e, waterInputMm, s), e, s.integral(), "pending");
}
AgroscopeState observeNextDay(Double stressNext, double setpoint, boolean lowConf,
                              double waterInputNext, AgroscopeState s) {     // update_with_next_day_observation
    if (stressNext == null || lowConf) return s;                             // carry, no integrate
    double eNext = setpoint - stressNext;
    double nextTarget = buildDose(eNext, waterInputNext, s);
    double integral = (0.0 < nextTarget && nextTarget < MAX_DOSE_MM) ? s.integral() + s.ki() * eNext : s.integral();
    return new AgroscopeState(integral, eNext, s.kp(), s.ki(), "closed", null);
}
```
Config gains are constructor defaults; `AgroscopeState` loaded from DB **overrides** them (reproduce gain-reload). Rain-freeze here only forces `dose=0`/`status=frozen`; the eventual next-day close still integrates (faithful to `main.py`).
- [ ] **Step 4:** PASS. Commit `feat(agroscope): faithful DendroIrrigationPID (propose/close, anti-windup, quirks)`.

## Task 6: Persistence entities + repos (mirror the RDI `DendroRdi*` files)
- [ ] `AgroscopeTreeState` (`@Id deviceId`, `historicalMaxUm`, `lastEndMaxUm`, `lastProcessedDate`) + `AgroscopeTreeStateRepository.findByDeviceId`.
- [ ] `AgroscopeShadowState` (`@Id zoneId`, gains/integral/lastError/status/pendingDate) + repo `findByZoneId`; add `toState()`/`applyState()` like `DendroRdiState`.
- [ ] `AgroscopeShadowDaily` + repo: `findByZoneIdAndDate` (upsert), `findByZoneIdAndDateBetweenOrderByDate` (compare).
- [ ] Compile + a JPA round-trip test. Commit `feat(agroscope): tree/shadow/daily persistence`.

## Task 7: `AgroscopeShadowService` (`REQUIRES_NEW` orchestration — mirror `RdiShadowService`)
**Interface:** `@Transactional(propagation = REQUIRES_NEW) void runShadow(IrrigationZone zone, List<TreeResult> nonRefTrees, LocalDate today)`. (No `windowStart/End` — the service owns its window, B2. `nonRefTrees`: same tree set v6 uses; **deliberate deviation** — OSI's ref trees are unirrigated baselines Agroscope has no concept of; documented, and the oracle uses the same set, I5.)
- [ ] **Step 1: Failing test** (`AgroscopeShadowServiceTest`, real bean + mocked repos): a metered opted-in zone writes one `agroscope_shadow_daily` row with `dose_mm ≥ 0`, `status ∈ {pending,frozen,skipped}`, and a `stress_upper95_um`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** the sequence (mirroring `RdiShadowService`, but Agroscope logic):
  1. `OptionalDouble waterOpt = agroscopeWaterInput.dailyWaterInputMm(zone, today)`; **if empty → return** (no areaM2). `waterInputMm = waterOpt.getAsDouble()`.
  2. **Resolve setpoint first** (I6a): `setpoint = zone.getAgroscopeSetpointOverrideUm() != null ? override : -100.0` (source `override|default`).
  3. Per tree/device: compute the **Agroscope-day window** (B2/B3) — `from = (state.lastProcessedDate() == null ? earliest-retained-raw : state.lastProcessedDate().plusDays(1))` at **03:00 zone-local**, `to = today.plusDays(1)` at 03:00 zone-local; `findDendroRawForPeriod(deviceId, fromInstant, toInstant)`; load `AgroscopeTreeState`; `extractor.extract(entries, zoneId, state)`; persist updated `AgroscopeTreeState` (hwm/lastEndMax/lastProcessedDate). Collect today's per-tree `treeStressUm`.
  4. `ZoneStress zs = aggregator.aggregate(perTreeStressToday)`; `lowConf = zs.n() == 0 || zs.upper95Um() == null` (**arm's own pipeline only — do NOT OR v6's flag**, I3).
  5. Load `AgroscopeShadowState` (or default gains). **Close** a prior-day pending cycle: if `state.pendingDate() != null && state.pendingDate().isBefore(today)` → `state = controller.observeNextDay(zs.upper95Um(), setpoint, lowConf, waterInputMm, state)` (close uses **today's** setpoint — Agroscope uses its current `tree_daily_limit`).
  6. `forecastRainMm = weatherResolver == null ? 0.0 : weatherResolver.getWeatherForDay(zone, today.plusDays(1)).map(WeatherSnapshot::precipitationMm).orElse(0.0)` — **next-day forecast** for the day the dose is applied (mirrors the RDI arm; a **deliberate deviation** from Agroscope's latent forecast-rain quirk, I1; replicate this exact rule in the oracle).
  7. `AgroscopeResult r = controller.propose(zs.upper95Um(), setpoint, forecastRainMm, lowConf, waterInputMm, state)`.
  8. **Upsert** `agroscope_shadow_daily` via `findByZoneIdAndDate` (stress mean/sd/n, setpoint+source, `r.error()` (null on skipped), `r.doseMm()`, integral_after, forecast_rain, water_input, low_confidence, status). Save `AgroscopeShadowState`: `pending_date=today`, `status=r.status()` **only** when `status ∈ {pending,frozen}`; on `skipped` leave the prior pending cycle untouched.
- [ ] **Step 4:** PASS. Commit `feat(agroscope): REQUIRES_NEW shadow orchestration (own tx, 03:00 window, cold-start backfill)`.

## Task 8: Wire into `computeForZone` + isolation/poison tests
- [ ] In `DendroAnalyticsService.computeForZone`, **after** the RDI-shadow block (`:246-258` on the RDI branch), add — guarded by `zone.isAgroscopeShadowEnabled()`:
```java
if (zone.isAgroscopeShadowEnabled() && agroscopeShadowService != null) {
    try {
        agroscopeShadowService.runShadow(zone, allNonRef, today);   // lowConf + window derived inside
    } catch (Exception e) {
        long n = AGRO_SHADOW_FAILURES.incrementAndGet();
        log.error("Agroscope shadow failed zone {}: {} (total {})", zone.getId(), e.getMessage(), n, e);
    }
}
```
  (`allNonRef`, `today` are in scope; the Agroscope arm owns its own 03:00 window inside `runShadow`.)
- [ ] **Isolation + poison tests** (mirror the RDI arm exactly): (a) opted-in zone's v6 `irrigationAction`/reasoning byte-identical to shadow-off; (b) `agroscope_shadow_enabled=false` writes no row; (c) **real-bean poison** — `AgroscopeShadowService` with a throwing daily repo → v6 recs for that zone and another zone in the same `computeForAllZones()` still commit.
- [ ] Fix `new DendroAnalyticsService(...)` test construction sites (grep; add the `agroscopeShadowService` arg). Run analytics tests. Commit `feat(agroscope): compute + persist shadow (no actuation change)`.

## Task 9: `/dendro/shadow/compare` 3-way endpoint
- [ ] Add (admin-guarded), **date set driven from v6 recommendations** (orphan-safe, per the RDI compare fix): per date return v6 `irrigationAction` | RDI `adjustment` (+`twdRel`) | Agroscope `doseMm` (+`stressUpper95Um`, `nTrees`), plus **one common metric: each arm's next-day tracking error vs its own setpoint**. Sources (v6 persists no numeric setpoint): RDI = `dendro_rdi_daily.error`; Agroscope = `agroscope_shadow_daily.error`; **v6** = realized zone `TWD_rel` (next day) minus `DendroCalibration.stressThresholdsRelative().mild()` — compute from the persisted `ZoneDailyRecommendation` twdRel + the zone calibration, or mark `null` if unavailable. Join the persisted series; document that v6's tracking error is derived, not persisted.
- [ ] Test the joined series + tracking-error columns for a zone with all three present. Commit `feat(agroscope): 3-way shadow compare endpoint + tracking-error metric`.

## Task 10: Python golden-master oracle
Implements the resolved comparability approach. **Key trick:** synthesize the *voltage* fixture from the µm
series (`V(t) = position_mm(t)·1000/g + V0`, `g = sensor_length·1000/voltage_reference`, e.g. `sensor_length=15.0,
voltage_reference=3.0 → g=5000`, `V0` so values sit in ~(0.5 V, Vref)); then Python's internal µm ≡ Java's
`position_mm×1000` up to a constant that **cancels in the stress difference**. **Assert only on
`tree_stress_um`, `stress_upper95_um`, `dose_mm`, `integral_after`; never on absolute endMax/HWM.**

- [ ] **Step 1: `tools/agroscope_oracle.py`** — per case: build a fake sensor
  (`SimpleNamespace(mqtt_topic='dragino_test', polarity='normal', dendro_jumps_dates=None, sensor_length=L,
  voltage_reference=Vref, ...)`), synthesize voltage from the µm fixture, run the **real** `Baseline.dendro_processing(full_history=True)`,
  replicate `main.py:262-269` SEM in pandas, run `watermeter_processing` with `water_meter_mode='dedicated'`
  under **freezegun** (its crop uses `datetime.now()`) reading its daily column by its real name **`'value'`**
  (the `irrigation_mm` rename is an index no-op), and drive the real `DendroIrrigationPID(db_path=None)` through
  `main.py`'s exact loop (close-if-pending-and-date-differs → rain branch `forecast>2.0`→pending dose 0 → else
  propose), with per-day `forecast_rain_mm` and the **next-day** rain rule matching Task 7 step 6. Write
  `src/test/resources/agroscope/oracle/<case>.json` (per day: `tree_stress_um`, `stress_upper95_um`,
  `water_input_mm`, `dose_mm`, `integral_after`).
- [ ] **Step 2: `AgroscopeOracleParityTest`** feeds the same fixtures through the Java extractor + aggregator +
  `AgroscopeWaterInput` (mocked `ZoneDailyEnvironmentRepository` returning the fixture daily litres; `areaM2`
  from the fixture) + controller; zone tz set to the fixture's **DST-free** IANA zone (Europe/Zurich within
  May 1–Jul 15 or Aug 1–Oct 15). Assert each asserted series within `1e-3` relative.
- [ ] **Required cases** (this is what makes the match *prove* parity): (1) `clean` — multiple closes, growth+deficit;
  (2) `nan-day` — an engineered no-coverage day → NaN stress that day **and the next** (B1) + pending survives with exactly one `Ki·e` step (no gap scaling); (3) `saturation` — one day clamped at 10 mm, one at 0 → anti-windup on both edges; (4) `rain-freeze` — a day with forecast>2 mm → dose 0/frozen and the next close still integrates; (5) `warm-restart split` (**Java-only**) — run the fixture in two batches persisting `agroscope_tree_state`/`agroscope_shadow_state` between; assert bit-identical to the single-batch run (proves persisted-HWM ≡ full-history cummax across the NaN day); (6) `water-parity` — `flow_liters/areaM2` vs the Python daily series within tolerance (a material gap → slice A's raw-path follow-up).
- [ ] Commit `test(agroscope): python golden-master oracle + java parity (6 cases)`.

## Final verification
- [ ] `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend` → BUILD SUCCESSFUL.
- [ ] Confirm: opted-in zone v6 actuation unchanged; opt-out writes nothing; oracle parity green.

## Self-review (coverage map)
| Spec item | Task |
|---|---|
| tables + zone flags | 1, 2 |
| global-cummax stress + persisted HWM | 3 |
| SEM upper-95 (n=1→mean) | 4 |
| faithful PID (e=setpoint−obs, anti-windup, rain-freeze) | 5 |
| reproduced quirks (gain-reload, no-gap, SEM coupling) | 4, 5 |
| warm-restart persistence | 6, 7 |
| REQUIRES_NEW isolation + no actuation change | 7, 8 (poison test) |
| measured water (slice A) | 7 |
| 3-way compare + tracking metric | 9 |
| golden-master parity (incl. water) | 10 |
