# Closed-Loop RDI Controller (v6 Shadow) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Add a corrected closed-loop PI controller as a *shadow* decision path in dendro v6 — targets a mild-deficit RDI setpoint on the zone's existing `TWD_rel`, self-corrects from the tree's next-day response, persists its output alongside v6's for comparison, and **changes no actuation.**

**Architecture:** New `RdiController` invoked from `DendroAnalyticsService.computeForZone` for opted-in zones, after the existing `irrDecision(...)`. It reads the zone's continuous aggregated `TWD_rel`, a hybrid RDI setpoint, forecast rain, and v6's confidence flag; writes a `dendro_rdi_daily` row + updates a per-zone `dendro_rdi_state` (warm-restart). Isolated tables; additive; cloud-only.

**Tech Stack:** Java 21, Spring Boot, JPA, Flyway (Postgres), Lombok, JUnit5 + AssertJ + Mockito. Build/test from `osi-server/backend`: `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend`.

## Global Constraints
- Spec: [closed-loop-rdi-controller-design.md](closed-loop-rdi-controller-design.md).
- **Shadow only:** the controller MUST NOT alter v6's `ActionResult`, `ZoneDailyRecommendation.irrigationAction`, schedule policy, or any actuation. A regression test proves an opted-in zone's actuated recommendation is byte-identical to before.
- **Transaction isolation:** `computeForAllZones()` is one `@Transactional` over all zones — the shadow persistence MUST run in its own `REQUIRES_NEW` transaction (`RdiShadowService`) and be called inside a try/catch, so a shadow failure can never mark the shared tx rollback-only and drop every zone's v6 recommendation.
- **Unit correctness:** the controller's observed signal and its setpoint are both dimensionless `TWD_rel` (`twdDay/mdsMaxReferenceUm`). Never feed the µm `TWD_day` p75 into the controller.
- Opt-in: compute the shadow only when `irrigation_zones.rdi_shadow_enabled = true`.
- Corrected PI: integrate the first error; never double-integrate (guard same-day re-runs with `pendingDate.isBefore(today)`); anti-windup (integral accrues only when the tentative output is unsaturated, `|output| < maxAdj`); scale/skip integration across missing/low-confidence days and never integrate a `frozen` (rain) cycle; explicit gain precedence (config wins — the persisted `kp`/`ki` columns are audit/warm-restart only, never override config); surfaced errors; warm-restart (pending pre-update / closed post-update).
- Date-based Flyway version (the weather work landed `V2026_07_05_001`; use `V2026_07_05_002`). Commit per task; branch off `main`, not on `main`.

## File structure
| File | Action |
|---|---|
| `db/migration/V2026_07_05_002__dendro_rdi_shadow.sql` | Create (2 tables + 2 zone columns) |
| `zone/IrrigationZone.java` | Modify (`rdiShadowEnabled`, `rdiTargetOverride`) |
| `analytics/DendroAnalyticsService.java` | Modify (surface p75 over `twdRel`; call `RdiShadowService` for opted-in zones) |
| `analytics/RdiController.java` + `RdiResult`/`RdiState` | Create (PI control law) |
| `analytics/RdiSetpoint.java` (or a helper) | Create (hybrid setpoint derivation) |
| `analytics/RdiShadowService.java` | Create (`REQUIRES_NEW` shadow orchestration + upsert persistence) |
| `analytics/DendroRdiState.java` + repo, `DendroRdiDaily.java` + repo | Create (persistence) |
| `analytics/DendroController.java` | Modify (compare read endpoint) |

---

## Task 1: Migration
- [ ] Create `V2026_07_05_002__dendro_rdi_shadow.sql`:
```sql
-- Closed-loop RDI controller (shadow). Isolated, additive, droppable.
ALTER TABLE irrigation_zones ADD COLUMN IF NOT EXISTS rdi_shadow_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE irrigation_zones ADD COLUMN IF NOT EXISTS rdi_target_override DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS dendro_rdi_state (
    zone_id      BIGINT PRIMARY KEY REFERENCES irrigation_zones(id) ON DELETE CASCADE,
    integral     DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_error   DOUBLE PRECISION,
    kp           DOUBLE PRECISION NOT NULL,
    ki           DOUBLE PRECISION NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'idle',
    pending_date DATE,
    updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dendro_rdi_daily (
    id               BIGSERIAL PRIMARY KEY,
    zone_id          BIGINT NOT NULL REFERENCES irrigation_zones(id) ON DELETE CASCADE,
    date             DATE NOT NULL,
    observed_twd_rel DOUBLE PRECISION,
    setpoint         DOUBLE PRECISION,
    setpoint_source  VARCHAR(12),          -- derived | override
    error            DOUBLE PRECISION,
    adjustment       DOUBLE PRECISION,     -- recommended water-volume adjustment (shadow)
    integral_after   DOUBLE PRECISION,
    forecast_rain_mm DOUBLE PRECISION,
    low_confidence   BOOLEAN NOT NULL DEFAULT false,
    status           VARCHAR(20) NOT NULL DEFAULT 'proposed',
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT uq_rdi_daily UNIQUE (zone_id, date)
);
```
- [ ] `./gradlew compileJava` → SUCCESS. Commit `feat(rdi): migration — dendro rdi shadow tables + zone flags`.

## Task 2: `IrrigationZone` fields
- [ ] Add next to the weather/calibration fields:
```java
    @Column(name = "rdi_shadow_enabled", nullable = false)
    @Builder.Default private boolean rdiShadowEnabled = false;

    @Column(name = "rdi_target_override")
    private Double rdiTargetOverride;
```
- [ ] Compile. Commit `feat(rdi): IrrigationZone rdi shadow flag + setpoint override`.

## Task 3: Surface the continuous zone `TWD_rel`
The controller needs the zone's continuous aggregated **relative** deficit, on the same dimensionless scale
as the RDI setpoint (Task 5, `stressThresholdsRelative().mild()` ≈ 0.4). **CRITICAL — unit correctness:**
`aggregateZoneStress` already computes `double p75 = percentile(filteredVals, 0.75)` (line ~541), but
`filteredVals` maps `t.twdDayUm` — that p75 is **absolute TWD_day in µm** (tens–hundreds), NOT `TWD_rel`.
The per-tree relative field is separate: `t.twdRel = round(twdDay / t.mdsMaxReferenceUm, 3)` (line ~401),
dimensionless. Surfacing the µm p75 against a ~0.4 setpoint would peg the controller permanently — so we
compute a **new** p75 over `twdRel`. Do NOT reuse the µm `p75` and do NOT touch the existing stress-level logic.

The `ZoneAggregation` record today is 6-field:
`record ZoneAggregation(String zoneStress, List<TreeResult> usableTrees, int usableTreeCount, int lowConfidenceTreeCount, int outlierFilteredTreeCount, Double zoneConfidenceScore)`.
- [ ] Add a trailing `Double zoneTwdRel` component. Just before the normal-return block (after the µm `p75`
  line ~541, over the already-computed `filteredTrees`), add:
```java
List<Double> relVals = filteredTrees.stream()
        .map(t -> t.twdRel).filter(Objects::nonNull).sorted().toList();
Double zoneTwdRel = relVals.isEmpty() ? null : percentile(relVals, 0.75);
```
- [ ] Update **all 5** `new ZoneAggregation(...)` call sites: the two early-returns (no-usable-trees ~L489,
  `twdVals` empty ~L510) are **above** `filteredTrees`, so they pass `null`; the three later sites (~L557
  severe-quorum, ~L570 significant-quorum, ~L579 normal) pass `zoneTwdRel`.
- [ ] Test: `aggregateZoneStress` returns `zoneTwdRel` equal to the 75th percentile **of `twdRel`** (not
  `twdDayUm`) for a set of trees with distinct `twdRel`; null when no tree has a non-null `twdRel` (baseline
  warm-up). Assert the value is on the relative scale (e.g. ~0.3–0.8), not µm. Run `./gradlew test --tests "org.osi.server.analytics.DendroAnalytics*" -x buildFrontend -x buildTerraIntelligenceFrontend`.
- [ ] Commit `feat(rdi): surface continuous zone TWD_rel (p75 over twdRel) from aggregation`.

## Task 4: `RdiController` (corrected PI) + `RdiResult`/`RdiState`
Status vocabulary (used by `RdiState.status` / `dendro_rdi_daily.status`): `idle` (no pending cycle),
`pending` (proposed, awaiting next-day close), `frozen` (proposed under rain feed-forward — must NOT integrate
at close), `closed` (cycle integrated).
- [ ] Write failing tests (`RdiControllerTest`): (a) first error IS integrated; (b) calling the close phase
  twice does NOT double-integrate; (c) anti-windup — integral does not grow when the tentative output is
  saturated (`|Kp·e + integral| ≥ maxAdj`); (d) a low-confidence day SKIPS the integral update and carries
  state; (e) a multi-day gap scales/skips rather than treating non-adjacent days as adjacent; (f) output is
  clamped to `±maxAdj`; (g) forecast rain above threshold freezes the proposal (`status=frozen`, non-positive
  adjustment, no integral update); (h) closing a `frozen` cycle does NOT integrate (learns nothing from rain);
  (i) closing with a `null` observed value (no-data day) does NOT throw and does NOT integrate.
- [ ] Implement `RdiController` with:
  - `record RdiState(double integral, Double lastError, double kp, double ki, String status, LocalDate pendingDate)`;
  - `record RdiResult(double adjustment, double error, double integralAfter, String status)`;
  - a **propose** step: `RdiResult propose(double observedTwdRel, double setpoint, double forecastRainMm, boolean lowConfidence, RdiState state, LocalDate day)` computing `e = observedTwdRel − setpoint`, the clamped `Kp·e + integral` output, and rain-freeze (if `forecastRainMm ≥ rainThreshold`: `status=frozen`, `adjustment = min(0, clamped)`); returns the proposal — **state's integral is unchanged at propose**;
  - a **close/observe** step: `RdiState observeNextDay(Double nextObservedTwdRel, double setpoint, boolean lowConfidence, RdiState state, long daysElapsed)` — accepts a **nullable** observed (M1). It integrates exactly once, and ONLY when **all** hold: `nextObservedTwdRel != null`, `!lowConfidence`, `state.status()` is not `frozen`, and the *tentative* output `output = Kp·e + state.integral()` (pre-update integral, `e = nextObservedTwdRel − setpoint`) is unsaturated (`|output| < maxAdj` — no lower bound). When integrating: `integral += Ki·e` scaled/guarded for `daysElapsed` (skip when `daysElapsed > maxGapDays`); set `lastError`; `status=closed`. Otherwise carry state unchanged except `status` (skip-integration cases keep the pending cycle open). Anti-windup gates on this close-time tentative output, not the prior day's proposed output.
  - Gains from explicit config (constructor/params), never DB-overrides-config silently.
- [ ] Tests green. Commit `feat(rdi): corrected PI controller (first-error, anti-windup, gap/frozen/null-safe)`.

## Task 5: Hybrid RDI setpoint
- [ ] `RdiSetpoint.resolve(IrrigationZone zone, DendroCalibration cal, double phenoMod)`:
  `zone.getRdiTargetOverride() != null ? (override, "override") : (cal.stressThresholdsRelative().mild() * phenoMod, "derived")`.
- [ ] Test: override wins when set; else derived = mild-relative × phenoMod; the source label is correct.
- [ ] Commit `feat(rdi): hybrid RDI setpoint (derived from calibration + per-zone override)`.

## Task 6: Persistence entities + repos
- [ ] `DendroRdiState` entity (`@Id zoneId`) + `DendroRdiStateRepository.findByZoneId`.
- [ ] `DendroRdiDaily` entity + `DendroRdiDailyRepository`: `findByZoneIdAndDate` (for the same-day **upsert**
  in Task 7 — update the existing row instead of blind-inserting into `uq_rdi_daily`),
  `findByZoneIdOrderByDateDesc`, and `findByZoneIdAndDateBetweenOrderByDate` (for the Task 8 `from/to` range).
- [ ] Compile + a JPA slice or unit test round-tripping a row. Commit `feat(rdi): rdi state + daily persistence`.

**Transaction isolation (H1 — mandatory).** `computeForAllZones()` is a **single `@Transactional`** (L108)
looping every zone; its per-zone `catch` (L118) only logs and does NOT clear rollback-only. A shadow-path
persistence exception would mark the shared transaction rollback-only → the day's commit fails → **every
zone's v6 recommendation is lost**, violating "shadow only." A plain try/catch cannot fix this: once a
Spring-Data op throws inside the current tx, the tx is already rollback-only. Therefore the shadow persistence
MUST run in its **own** transaction. Put the whole shadow block in a new `RdiShadowService` bean whose entry
method is `@Transactional(propagation = Propagation.REQUIRES_NEW)`, and call it from `computeForZone` wrapped
in a try/catch that logs and swallows. A shadow failure then rolls back only the nested tx; v6 commits intact.

- [ ] Create `RdiShadowService` (injects `RdiController`, `RdiSetpoint`, `WeatherResolver`,
  `DendroRdiStateRepository`, `DendroRdiDailyRepository`) with:
  `@Transactional(propagation = Propagation.REQUIRES_NEW) void runShadow(IrrigationZone zone, DendroCalibration cal, double phenoMod, LocalDate today, Double zoneTwdRel, boolean lowConfidence, double rainfallMm)`:
  1. `RdiState state = rdiStateRepository.findByZoneId(zone.getId()).map(DendroRdiState::toState).orElseGet(() -> defaultState(gains))`;
  2. **close** a *prior-day* pending cycle only — guard `state.pendingDate() != null && state.pendingDate().isBefore(today)` (H2: without this, a same-day re-run — manual recompute exists at `DendroController` `recompute`, and v6 upserts — would close today's own cycle and double-integrate). Compute `daysElapsed = DAYS.between(state.pendingDate(), today)`; `state = rdiController.observeNextDay(zoneTwdRel, setpoint(prevDay), lowConfidence, state, daysElapsed)` (observed may be null → carried, no integrate);
  3. resolve setpoint via `RdiSetpoint.resolve(zone, cal, phenoMod)`;
  4. forecast rain — `WeatherResolver` may be null in tests (M3: v6 guards `weatherResolver != null` at L135), so:
     `double forecastRainMm = (weatherResolver == null) ? rainfallMm : weatherResolver.getWeatherForDay(zone, today.plusDays(1)).map(WeatherSnapshot::precipitationMm).orElse(rainfallMm);`
     (`precipitationMm` is a primitive `double`; `rainfallMm` — today's value passed in from L139 — is the fallback);
  5. `RdiResult r = rdiController.propose(zoneTwdRel, setpoint, forecastRainMm, lowConfidence, state, today)`;
  6. **upsert** `dendro_rdi_daily` via `findByZoneIdAndDate(zoneId, today)` (update else insert — never blind-insert into `uq_rdi_daily`): observed, setpoint(+source), error, adjustment, integral_after, forecast_rain, low_confidence, status (`frozen` if rain-frozen else `pending`). Save updated `dendro_rdi_state` with `pending_date = today`, `status` matching.
- [ ] In `DendroAnalyticsService.computeForZone`, AFTER `ActionResult decision = irrDecision(...)` (`:194`) and
  the existing persistence, add — guarded by `zone.isRdiShadowEnabled()`:
  ```java
  if (zone.isRdiShadowEnabled()) {
      boolean lowConfidence = UNKNOWN_STRESS.equals(zoneAggregation.zoneStress())
              || zoneAggregation.usableTreeCount() == 0 || zoneAggregation.zoneTwdRel() == null;
      try {
          rdiShadowService.runShadow(zone, cal, phenoMod, today,
                  zoneAggregation.zoneTwdRel(), lowConfidence, rainfallMm);
      } catch (Exception e) {
          log.error("RDI shadow failed zone {}: {}", zone.getId(), e.getMessage(), e);
      }
  }
  ```
  **Do not** modify `decision`, `rec.setIrrigationAction(...)`, schedule policy, or actuation. (`today`,
  `rainfallMm`, `phenoMod`, `cal`, `zoneAggregation` are all already in scope at `:194`.)
- [ ] **Isolation regression tests:** (a) an opted-in zone's `ZoneDailyRecommendation.irrigationAction` /
  reasoning / actuation is byte-identical to a run with the shadow disabled; (b) a `rdi_shadow_enabled=false`
  zone writes no `dendro_rdi_daily` row; (c) **poison test** — with `rdiShadowService` stubbed to throw,
  v6's `ZoneDailyRecommendation` for the zone (and other zones in the same run) still persists (proves the
  `REQUIRES_NEW` + try/catch isolation).
- [ ] Fix any `new DendroAnalyticsService(...)` test construction sites for the added `rdiShadowService`
  dependency (`grep -rn "new DendroAnalyticsService(" backend/src/test` — **4 sites**:
  `DendroAnalyticsWeatherResolverTest`, `DendroAnalyticsRecomputeRegressionTest`, `DendroAnalyticsScenarioTest`,
  `DendroRelativeClassificationTest`; pass a mock/null and gate the shadow off in those unless the test opts in).
  Run `./gradlew test --tests "org.osi.server.analytics.*" -x buildFrontend -x buildTerraIntelligenceFrontend`.
- [ ] Commit `feat(rdi): compute + persist shadow RDI recommendation (own tx, no actuation change)`.

## Task 8: Compare read endpoint
- [ ] Add a read-only endpoint (in `DendroController`, admin-guarded): `GET /dendro/rdi/compare?zoneId&from&to`
  → per date: v6's `irrigationAction` (from `ZoneDailyRecommendation`) + the `dendro_rdi_daily` fields
  (observed_twd_rel, setpoint, error, adjustment). No new computation — just join the two persisted series.
- [ ] Test the endpoint returns the joined series for a zone with both present. Commit `feat(rdi): shadow-vs-v6 compare endpoint`.

## Final verification
- [ ] `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend` → BUILD SUCCESSFUL.
- [ ] Confirm the isolation invariant: an opted-in zone's actuated recommendation is unchanged; opt-out writes nothing.

## Self-review (coverage map)
| Spec item | Task |
|---|---|
| tables + zone flags | 1, 2 |
| continuous zone TWD_rel (p75 over `twdRel`, relative scale) | 3 |
| corrected PI (first-error/anti-windup/gap/clamp/rain-freeze/frozen-close/null-safe) | 4 |
| hybrid setpoint | 5 |
| warm-restart persistence + range/upsert finders | 6 |
| shadow wiring, own `REQUIRES_NEW` tx, no actuation change | 7 (+ isolation & poison tests) |
| same-day re-run safety (no double-integrate) | 7 (`pendingDate.isBefore(today)`) |
| opt-in default off | 1, 7 |
| comparison harness | 8 |
