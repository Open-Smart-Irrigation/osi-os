# Agroscope Slice A — Water Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose OSI's *already-measured* daily flow-meter volume as the Agroscope controller's `water_input_mm`, and verify it against Agroscope's `watermeter_processing` via the golden-master oracle.

**Architecture:** Water-meter ingestion is **already built** (Dragino LSN50 pulse count mode → `flow_*` channels → measured daily litres in `zone_daily_environment.flow_liters`, counter-reset handled). This slice adds only a tiny read helper `AgroscopeWaterInput` (`flow_liters / areaM2 → mm`) consumed by slice C, plus a parity assertion in C's oracle. No new ingestion.

**Tech Stack:** Java 21, Spring Boot, JPA, JUnit5 + AssertJ + Mockito. Build/test from `osi-server/backend`: `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend`.

## Global Constraints
- Spec: [agroscope-integration-overview.md](../../architecture/agroscope-integration-overview.md) (interface A→C) + [agroscope-shadow-controller-design.md](../../architecture/agroscope-shadow-controller-design.md).
- **Measured only, never estimated.** `water_input_mm = zone_daily_environment.flow_liters / IrrigationZone.areaM2`. A zone with no `areaM2` is **not opted in** (helper returns empty). **I4 guard:** `areaM2` alone does not prove a flow meter exists — an opted-in zone with an area but no meter would silently run `water=0` forever (the substitute-estimate the spec forbids). The Agroscope opt-in (`agroscope_shadow_enabled`) is the operator's assertion the zone is metered; additionally **warn-log** (in slice C Task 7) when an opted-in zone has no flow device / no `flow_*` history, so a misconfigured meterless zone is visible rather than silently degrading to gross dose.
- Do NOT rebuild ingestion; `flow_liters` already exists (`ZoneDailyEnvironment.flowLiters`, `ZoneDailyEnvironmentRepository.findByZoneIdAndDate`).
- Branch off `feat/rdi-shadow-controller` (slice C builds on the RDI shadow, PR #49, not yet merged). Commit per task.

## File structure

| File | Action |
|---|---|
| `analytics/AgroscopeWaterInput.java` | Create (helper: daily measured mm) |
| `analytics/AgroscopeWaterInputTest.java` | Create (unit tests) |

---

## Task 1: `AgroscopeWaterInput` helper

**Files:**
- Create: `backend/src/main/java/org/osi/server/analytics/AgroscopeWaterInput.java`
- Test: `backend/src/test/java/org/osi/server/analytics/AgroscopeWaterInputTest.java`

**Interfaces:**
- Consumes: `ZoneDailyEnvironmentRepository.findByZoneIdAndDate(Long, LocalDate) → Optional<ZoneDailyEnvironment>` (`getFlowLiters()`), `IrrigationZone.getAreaM2() → Double`.
- Produces: `OptionalDouble dailyWaterInputMm(IrrigationZone zone, LocalDate day)` — measured mm, or `OptionalDouble.empty()` when the zone has no `areaM2` (not metered/opted-in). `1 litre / 1 m² = 1 mm`.

- [ ] **Step 1: Write the failing test**

```java
package org.osi.server.analytics;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.osi.server.zone.IrrigationZone;

import java.time.LocalDate;
import java.util.Optional;
import java.util.OptionalDouble;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AgroscopeWaterInputTest {

    @Mock ZoneDailyEnvironmentRepository envRepo;

    private static final LocalDate DAY = LocalDate.of(2026, 7, 1);

    @Test
    void litresOverAreaGivesMm() {
        AgroscopeWaterInput helper = new AgroscopeWaterInput(envRepo);
        IrrigationZone zone = IrrigationZone.builder().id(7L).areaM2(200.0).build();
        ZoneDailyEnvironment env = new ZoneDailyEnvironment();
        env.setFlowLiters(500.0);                      // 500 L over 200 m² = 2.5 mm
        when(envRepo.findByZoneIdAndDate(7L, DAY)).thenReturn(Optional.of(env));

        OptionalDouble mm = helper.dailyWaterInputMm(zone, DAY);

        assertThat(mm).isPresent();
        assertThat(mm.getAsDouble()).isEqualTo(2.5);
    }

    @Test
    void noEnvRowMeansZeroMeasuredWater() {
        AgroscopeWaterInput helper = new AgroscopeWaterInput(envRepo);
        IrrigationZone zone = IrrigationZone.builder().id(7L).areaM2(200.0).build();
        when(envRepo.findByZoneIdAndDate(7L, DAY)).thenReturn(Optional.empty());

        OptionalDouble mm = helper.dailyWaterInputMm(zone, DAY);

        assertThat(mm).hasValue(0.0);                  // metered zone, genuine data gap → 0 (COALESCE)
    }

    @Test
    void noAreaMeansNotOptedIn() {
        AgroscopeWaterInput helper = new AgroscopeWaterInput(envRepo);
        IrrigationZone zone = IrrigationZone.builder().id(7L).areaM2(null).build();

        OptionalDouble mm = helper.dailyWaterInputMm(zone, DAY);

        assertThat(mm).isEmpty();                      // no areaM2 → cannot compute mm → empty
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew test --tests "org.osi.server.analytics.AgroscopeWaterInputTest" -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL (compilation — `AgroscopeWaterInput` does not exist).

- [ ] **Step 3: Write minimal implementation**

```java
package org.osi.server.analytics;

import org.osi.server.zone.IrrigationZone;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.OptionalDouble;

/**
 * Agroscope water input: OSI's already-measured daily flow-meter volume as mm.
 * water_input_mm = zone_daily_environment.flow_liters / areaM2  (1 L / 1 m² = 1 mm).
 * Measured only — never an estimate. Empty when the zone has no areaM2 (not opted in).
 */
@Component
public class AgroscopeWaterInput {

    private final ZoneDailyEnvironmentRepository envRepo;

    public AgroscopeWaterInput(ZoneDailyEnvironmentRepository envRepo) {
        this.envRepo = envRepo;
    }

    public OptionalDouble dailyWaterInputMm(IrrigationZone zone, LocalDate day) {
        Double areaM2 = zone.getAreaM2();
        if (areaM2 == null || areaM2 <= 0.0) {
            return OptionalDouble.empty();
        }
        double litres = envRepo.findByZoneIdAndDate(zone.getId(), day)
                .map(ZoneDailyEnvironment::getFlowLiters)   // measured; counter-reset handled upstream
                .orElse(0.0);
        return OptionalDouble.of(litres / areaM2);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew test --tests "org.osi.server.analytics.AgroscopeWaterInputTest" -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/AgroscopeWaterInput.java \
        backend/src/test/java/org/osi/server/analytics/AgroscopeWaterInputTest.java
git commit -m "feat(agroscope): water-input helper (measured flow_liters/areaM2)"
```

## Task 2: Oracle parity assertion (implemented in slice C's oracle harness)

The parity check — `flow_liters/areaM2` vs Agroscope's `watermeter_processing` daily mm on the shared
golden-master dataset — is a **test in slice C's Python-oracle harness** (see the C plan's oracle task). It is
listed here for A→C traceability, not implemented separately: assert the two daily-mm series match within
tolerance on the fixture; if they diverge materially (day-boundary / counter-reset), open a follow-up to port
the raw sub-daily `watermeter_processing` path from `flow_count_cumulative`.

- [ ] **Step 1:** Confirm the C oracle harness includes a `water_input_mm` column asserted against
  `flow_liters/areaM2`. (No separate commit — verified when C's oracle lands.)

## Self-review (coverage map)

| Spec item | Task |
|---|---|
| measured water_input_mm = flow_liters/areaM2 | 1 |
| not-opted-in when no areaM2 | 1 |
| COALESCE-0 on genuine gap | 1 |
| oracle parity vs watermeter_processing | 2 (in C) |
