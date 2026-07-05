# Closed-Loop RDI Controller (v6 Shadow) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Add a corrected closed-loop PI controller as a *shadow* decision path in dendro v6 — targets a mild-deficit RDI setpoint on the zone's existing `TWD_rel`, self-corrects from the tree's next-day response, persists its output alongside v6's for comparison, and **changes no actuation.**

**Architecture:** New `RdiController` invoked from `DendroAnalyticsService.computeForZone` for opted-in zones, after the existing `irrDecision(...)`. It reads the zone's continuous aggregated `TWD_rel`, a hybrid RDI setpoint, forecast rain, and v6's confidence flag; writes a `dendro_rdi_daily` row + updates a per-zone `dendro_rdi_state` (warm-restart). Isolated tables; additive; cloud-only.

**Tech Stack:** Java 21, Spring Boot, JPA, Flyway (Postgres), Lombok, JUnit5 + AssertJ + Mockito. Build/test from `osi-server/backend`: `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend`.

## Global Constraints
- Spec: [closed-loop-rdi-controller-design.md](closed-loop-rdi-controller-design.md).
- **Shadow only:** the controller MUST NOT alter v6's `ActionResult`, `ZoneDailyRecommendation.irrigationAction`, schedule policy, or any actuation. A regression test proves an opted-in zone's actuated recommendation is byte-identical to before.
- Opt-in: compute the shadow only when `irrigation_zones.rdi_shadow_enabled = true`.
- Corrected PI: integrate the first error; never double-integrate; anti-windup (integral accrues only when unsaturated); scale/skip integration across missing/low-confidence days; explicit gain precedence; surfaced errors; warm-restart (pending pre-update / closed post-update).
- Date-based Flyway version (the weather work landed `V2026_07_05_001`; use `V2026_07_05_002`). Commit per task; branch off `main`, not on `main`.

## File structure
| File | Action |
|---|---|
| `db/migration/V2026_07_05_002__dendro_rdi_shadow.sql` | Create (2 tables + 2 zone columns) |
| `zone/IrrigationZone.java` | Modify (`rdiShadowEnabled`, `rdiTargetOverride`) |
| `analytics/DendroAnalyticsService.java` | Modify (surface p75 `TWD_rel`; invoke controller; persist shadow) |
| `analytics/RdiController.java` + `RdiResult`/`RdiState` | Create (PI control law) |
| `analytics/RdiSetpoint.java` (or a helper) | Create (hybrid setpoint derivation) |
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
The controller needs the zone's continuous aggregated deficit. `DendroAnalyticsService.aggregateZoneStress`
already computes `p75 = percentile(filteredVals, 0.75)` internally (line ~541). The `ZoneAggregation` record
today is 6-field:
`record ZoneAggregation(String zoneStress, List<TreeResult> usableTrees, int usableTreeCount, int lowConfidenceTreeCount, int outlierFilteredTreeCount, Double zoneConfidenceScore)`.
Add a 7th component for the continuous deficit.
- [ ] Add a trailing `Double zoneTwdRel` component to the `ZoneAggregation` record. There are **5**
  `new ZoneAggregation(...)` call sites: the two early-returns (no-usable-trees ~L489, unknown ~L510) are
  **above** the `p75` computation, so they pass `null`; the three later sites (~L557 severe-quorum, ~L570
  significant-quorum, ~L579 normal) pass `p75`.
- [ ] Test: `aggregateZoneStress` returns a non-null `zoneTwdRel` equal to the 75th percentile for a set of
  trees; null when trees have no `twdDayUm`. Run `./gradlew test --tests "org.osi.server.analytics.DendroAnalytics*" -x buildFrontend -x buildTerraIntelligenceFrontend`.
- [ ] Commit `feat(rdi): surface continuous zone TWD_rel from aggregation`.

## Task 4: `RdiController` (corrected PI) + `RdiResult`/`RdiState`
- [ ] Write failing tests (`RdiControllerTest`): (a) first error IS integrated; (b) calling the close phase
  twice does NOT double-integrate; (c) anti-windup — integral does not grow when the raw output is saturated
  (`|Kp·e + integral| ≥ maxAdj`); (d) a low-confidence day SKIPS the integral update and carries state; (e) a
  multi-day gap scales/skips rather than treating non-adjacent days as adjacent; (f) output is clamped to
  `±maxAdj`; (g) forecast rain above threshold freezes (no integral update, non-positive adjustment).
- [ ] Implement `RdiController` with:
  - `record RdiState(double integral, Double lastError, double kp, double ki, String status, LocalDate pendingDate)`;
  - `record RdiResult(double adjustment, double error, double integralAfter, String status)`;
  - a **propose** step: `RdiResult propose(double observedTwdRel, double setpoint, double forecastRainMm, boolean lowConfidence, RdiState state, LocalDate day)` computing `e`, the clamped `Kp·e + integral` output, rain-freeze, and returning the proposal (state's integral unchanged at propose);
  - a **close/observe** step: `RdiState observeNextDay(double nextObservedTwdRel, double setpoint, boolean lowConfidence, RdiState state, long daysElapsed)` that computes `e = nextObservedTwdRel − setpoint` and the *tentative* output `output = Kp·e + state.integral()` (pre-update integral); only when confident and the tentative output is unsaturated (`0 < |output| < maxAdj`) does it advance `integral += Ki·e` exactly once (scaled/guarded for `daysElapsed`); always sets `lastError`, and returns the new state. (Anti-windup gates on this close-time tentative output, not the prior day's proposed output.)
  - Gains from explicit config (constructor/params), never DB-overrides-config silently.
- [ ] Tests green. Commit `feat(rdi): corrected PI controller (first-error, anti-windup, gap-safe)`.

## Task 5: Hybrid RDI setpoint
- [ ] `RdiSetpoint.resolve(IrrigationZone zone, DendroCalibration cal, double phenoMod)`:
  `zone.getRdiTargetOverride() != null ? (override, "override") : (cal.stressThresholdsRelative().mild() * phenoMod, "derived")`.
- [ ] Test: override wins when set; else derived = mild-relative × phenoMod; the source label is correct.
- [ ] Commit `feat(rdi): hybrid RDI setpoint (derived from calibration + per-zone override)`.

## Task 6: Persistence entities + repos
- [ ] `DendroRdiState` entity (`@Id zoneId` or `@OneToOne` zone) + `DendroRdiStateRepository.findByZoneId`.
- [ ] `DendroRdiDaily` entity + `DendroRdiDailyRepository.findByZoneIdAndDate` / `findByZoneIdOrderByDateDesc`.
- [ ] Compile + a JPA slice or unit test round-tripping a row. Commit `feat(rdi): rdi state + daily persistence`.

## Task 7: Wire the shadow into `computeForZone`
- [ ] In `DendroAnalyticsService.computeForZone`, AFTER `ActionResult decision = irrDecision(...)` (`:194`)
  and the existing persistence, add — guarded by `zone.isRdiShadowEnabled()`:
  1. `RdiState state = rdiStateRepository.findByZoneId(zone.getId()).orElseGet(default gains)`;
  2. **close** yesterday's pending cycle if present: observe today's `zoneAggregation.zoneTwdRel()` vs the
     setpoint → `rdiController.observeNextDay(...)` → updated state;
  3. resolve setpoint via `RdiSetpoint.resolve(zone, cal, phenoMod)`;
  4. obtain forecast rain from the per-zone weather source — the resolver's only method is
     `getWeatherForDay(zone, LocalDate)`, so query next-day: `double forecastRainMm =
     weatherResolver.getWeatherForDay(zone, today.plusDays(1)).map(WeatherSnapshot::precipitationMm).orElse(rainfallMm);`
     (`precipitationMm` is a primitive `double`; `rainfallMm` — today's already-resolved value at L139 — is the fallback);
  5. `RdiResult r = rdiController.propose(zoneAggregation.zoneTwdRel(), setpoint, forecastRainMm, lowConfidence, state, today)`
     where `boolean lowConfidence = UNKNOWN_STRESS.equals(zoneAggregation.zoneStress()) || zoneAggregation.usableTreeCount() == 0 || zoneAggregation.zoneTwdRel() == null;`
     (guard the null `zoneTwdRel` from the early-return sites so a no-data zone skips rather than NPEs);
  6. persist a `dendro_rdi_daily` row (observed, setpoint(+source), error, adjustment, integral_after,
     forecast_rain, low_confidence, status) and save the updated `dendro_rdi_state` (pending_date=today);
  7. **do not** modify `decision`, `rec.setIrrigationAction(...)`, schedule policy, or actuation.
- [ ] **Isolation regression test:** an opted-in zone's `ZoneDailyRecommendation.irrigationAction` /
  reasoning / actuation is identical to a run with the shadow disabled (byte-identical). And a
  `rdi_shadow_enabled=false` zone writes no `dendro_rdi_daily` row.
- [ ] Fix any `new DendroAnalyticsService(...)` test construction sites for the added dependencies
  (grep `new DendroAnalyticsService(`). Run `./gradlew test --tests "org.osi.server.analytics.*" -x buildFrontend -x buildTerraIntelligenceFrontend`.
- [ ] Commit `feat(rdi): compute + persist shadow RDI recommendation (no actuation change)`.

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
| continuous zone TWD_rel | 3 |
| corrected PI (first-error/anti-windup/gap/clamp/rain-freeze) | 4 |
| hybrid setpoint | 5 |
| warm-restart persistence | 6, 7 |
| shadow wiring, no actuation change | 7 (+ isolation test) |
| opt-in default off | 1, 7 |
| comparison harness | 8 |
