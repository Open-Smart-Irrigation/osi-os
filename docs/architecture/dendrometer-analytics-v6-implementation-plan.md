# Dendrometer Analytics v6 (Self-Calibrating & Robust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cloud-side dendrometer scheduler analytics self-calibrating (dimensionless `TWD_rel`), calibration-ready (DB-backed thresholds), and more robust (anchor outlier guard, solar-geometry extrema windows, consistent confidence gating, consistent recovery/VPD), without rewriting the v5 structure.

**Architecture:** All work is in `osi-server` `backend` (Spring Boot, Java 21, JPA, Flyway, JUnit5 + AssertJ), package `org.osi.server.analytics`, plus one optional `osi-os` React change. Classification shifts from absolute `TWD_day` (µm) to `TWD_rel = TWD_day / A_ref`, where `A_ref` is the existing well-watered baseline amplitude (`DendroBaseline.mdsMaxReferenceUm`). Every new path degrades to current v5 behavior when its input is unavailable. Spec: [dendrometer-analytics-v6-self-calibrating.md](dendrometer-analytics-v6-self-calibrating.md).

**Tech Stack:** Java 21, Spring Boot, Spring Data JPA, Flyway (PostgreSQL), Lombok, JUnit5, AssertJ. Build/test from `osi-server/backend`: `./gradlew test`.

---

## Conventions for this plan

- All `./gradlew` commands run from `/home/phil/Repos/osi-server/backend`.
- Run a single test class with: `./gradlew test --tests org.osi.server.analytics.<ClassName>`.
- Commit after each task. Branch off whatever feature branch the executor is on (do not commit to `main`).
- "Service" = `DendroAnalyticsService.java`. Line numbers are from the current revision and may drift — match on the quoted code, not the line number.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `db/migration/V2026_06_12_001__dendro_v6_self_calibrating.sql` | `dendro_daily.twd_rel` column; `dendro_calibrations` table + seed | Create |
| `analytics/DendroDaily.java` | add `twdRel` field | Modify |
| `analytics/DendroCalibration.java` | add relative thresholds + `classifyRelative` | Modify |
| `analytics/DendroCalibrationEntity.java` | JPA entity for `dendro_calibrations` | Create |
| `analytics/DendroCalibrationRepository.java` | repo for calibration rows | Create |
| `analytics/DendroCalibrationService.java` | DB lookup with in-code fallback | Create |
| `analytics/EnvelopeTwd.java` | anchor-eligibility + growth-rate guard | Modify |
| `analytics/SolarWindows.java` | sunrise/solar-noon → extrema windows | Create |
| `analytics/DendroAnalyticsService.java` | wire normalization, solar windows, gating, recovery/VPD | Modify |
| `web/react-gui/.../DraginoSettingsModal.tsx` (osi-os) | 3000 ms warm-up default | Modify (optional, Task 10) |

---

## Task 1: Migration — `twd_rel` column + `dendro_calibrations` table

**Files:**
- Create: `osi-server/backend/src/main/resources/db/migration/V2026_06_12_001__dendro_v6_self_calibrating.sql`

- [ ] **Step 1: Write the migration**

```sql
-- V2026_06_12_001: Dendrometer analytics v6 — self-calibrating normalization + DB-backed calibration.

-- dendro_daily: dimensionless self-calibrated deficit (TWD_day / A_ref). Null during baseline warm-up.
ALTER TABLE dendro_daily ADD COLUMN IF NOT EXISTS twd_rel DOUBLE PRECISION;

-- DB-backed per-crop calibration. Seeded from the in-code built-ins; admins may tune without redeploy.
CREATE TABLE IF NOT EXISTS dendro_calibrations (
    cal_key           VARCHAR(40)  PRIMARY KEY,
    crop              VARCHAR(60)  NOT NULL,
    twd_method        VARCHAR(20)  NOT NULL DEFAULT 'stepwise',
    -- Relative thresholds: multiples of A_ref applied to TWD_rel (primary classifier).
    rel_mild          DOUBLE PRECISION NOT NULL,
    rel_moderate      DOUBLE PRECISION NOT NULL,
    rel_significant   DOUBLE PRECISION NOT NULL,
    rel_severe        DOUBLE PRECISION NOT NULL,
    -- Absolute µm thresholds: warm-up fallback before A_ref exists (current v5 values).
    abs_mild_um       DOUBLE PRECISION NOT NULL,
    abs_moderate_um   DOUBLE PRECISION NOT NULL,
    abs_significant_um DOUBLE PRECISION NOT NULL,
    abs_severe_um     DOUBLE PRECISION NOT NULL,
    twd_max_calibrated_um DOUBLE PRECISION,
    -- Future ground-truth hook (logistic psi model); unused now.
    psi_a             DOUBLE PRECISION,
    psi_b             DOUBLE PRECISION,
    updated_at        TIMESTAMP    NOT NULL DEFAULT now()
);

INSERT INTO dendro_calibrations
    (cal_key, crop, twd_method,
     rel_mild, rel_moderate, rel_significant, rel_severe,
     abs_mild_um, abs_moderate_um, abs_significant_um, abs_severe_um,
     twd_max_calibrated_um)
VALUES
    ('default',   'default',   'stepwise', 0.5, 1.0, 2.0, 3.0,  30, 60, 100, 140, NULL),
    ('apple',     'apple',     'stepwise', 0.4, 0.9, 1.8, 2.8,  25, 55,  90, 130, 200),
    ('grapevine', 'grapevine', 'stepwise', 0.4, 0.8, 1.5, 2.5,  20, 40,  70, 100, 120),
    ('olive',     'olive',     'stepwise', 0.6, 1.2, 2.2, 3.2,  40, 80, 130, 180, 300)
ON CONFLICT (cal_key) DO NOTHING;
```

- [ ] **Step 2: Verify Flyway accepts it (compile + migrate in test context)**

Run: `./gradlew compileJava`
Expected: `BUILD SUCCESSFUL` (no schema validation here yet; table is exercised in Task 2).

- [ ] **Step 3: Commit**

```bash
git add backend/src/main/resources/db/migration/V2026_06_12_001__dendro_v6_self_calibrating.sql
git commit -m "feat(dendro): v6 migration — twd_rel column + dendro_calibrations table"
```

---

## Task 2: `DendroDaily` gains `twdRel`

**Files:**
- Modify: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroDaily.java`

- [ ] **Step 1: Add the field** after the `tree_state_v5` block (after the `treeStateV5` field, before the `// ── Quality + meta ──` section)

```java
    /** Self-calibrated dimensionless deficit: TWD_day / A_ref. Null during baseline warm-up. */
    @Column(name = "twd_rel")
    private Double twdRel;
```

- [ ] **Step 2: Compile**

Run: `./gradlew compileJava`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/DendroDaily.java
git commit -m "feat(dendro): add DendroDaily.twdRel"
```

---

## Task 3: `DendroCalibration` gains relative thresholds + `classifyRelative`

**Files:**
- Modify: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroCalibration.java`
- Test: `osi-server/backend/src/test/java/org/osi/server/analytics/DendroCalibrationTest.java`

- [ ] **Step 1: Write failing tests** — append inside `DendroCalibrationTest` (before the closing brace)

```java
    // ── Relative classification (v6) ───────────────────────────────────────────

    @Test
    void apple_hasRelativeThresholds() {
        assertThat(DendroCalibration.forKey("apple").stressThresholdsRelative()).isNotNull();
    }

    @Test
    void classifyRelative_belowMild_isNone() {
        // apple rel thresholds: 0.4 / 0.9 / 1.8 / 2.8
        assertThat(DendroCalibration.forKey("apple").classifyRelative(0.3, 1.0)).isEqualTo("none");
    }

    @Test
    void classifyRelative_atSevere_isSevere() {
        assertThat(DendroCalibration.forKey("apple").classifyRelative(2.8, 1.0)).isEqualTo("severe");
    }

    @Test
    void classifyRelative_phenoModTightensThresholds() {
        // phenoMod 0.5 halves thresholds → 1.0 now exceeds significant (1.8*0.5=0.9) but not severe (2.8*0.5=1.4)
        assertThat(DendroCalibration.forKey("apple").classifyRelative(1.0, 0.5)).isEqualTo("significant");
    }
```

- [ ] **Step 2: Run, verify failure**

Run: `./gradlew test --tests org.osi.server.analytics.DendroCalibrationTest`
Expected: FAIL — `stressThresholdsRelative()` / `classifyRelative` do not exist.

- [ ] **Step 3: Extend the record.** In `DendroCalibration.java`, add a component and update the built-ins + add the method.

Change the record header to add `stressThresholdsRelative` (place it directly after `stressThresholdsAbsoluteUm`):

```java
    /**
     * Absolute TWD_day thresholds (µm). Warm-up fallback used only until A_ref exists.
     */
    Thresholds stressThresholdsAbsoluteUm,

    /**
     * Relative TWD thresholds — multiples of A_ref applied to TWD_rel. Primary classifier.
     */
    Thresholds stressThresholdsRelative,
```

Update each built-in to pass the relative thresholds (insert a `new Thresholds(...)` argument right after the existing absolute one):

```java
    private static final Map<String, DendroCalibration> BUILT_IN = Map.of(

        "default", new DendroCalibration(
            "default", "stepwise", null,
            new Thresholds(30.0, 60.0, 100.0, 140.0),
            new Thresholds(0.5, 1.0, 2.0, 3.0), null),

        "apple", new DendroCalibration(
            "apple", "stepwise", 200.0,
            new Thresholds(25.0, 55.0, 90.0, 130.0),
            new Thresholds(0.4, 0.9, 1.8, 2.8), null),

        "grapevine", new DendroCalibration(
            "grapevine", "stepwise", 120.0,
            new Thresholds(20.0, 40.0, 70.0, 100.0),
            new Thresholds(0.4, 0.8, 1.5, 2.5), null),

        "olive", new DendroCalibration(
            "olive", "stepwise", 300.0,
            new Thresholds(40.0, 80.0, 130.0, 180.0),
            new Thresholds(0.6, 1.2, 2.2, 3.2), null)
    );
```

Add the relative classifier method (next to the existing `classify`):

```java
    /**
     * Classify stress from the dimensionless TWD_rel = TWD_day / A_ref, scaling
     * thresholds by {@code phenoMod} (≤ 1 tightens, > 1 relaxes). Primary classifier
     * once a tree's baseline amplitude A_ref is available.
     */
    public String classifyRelative(double twdRel, double phenoMod) {
        Thresholds t = stressThresholdsRelative;
        double m = phenoMod <= 0 ? 1.0 : phenoMod;
        if (twdRel >= t.severe()      * m) return "severe";
        if (twdRel >= t.significant() * m) return "significant";
        if (twdRel >= t.moderate()    * m) return "moderate";
        if (twdRel >= t.mild()        * m) return "mild";
        return "none";
    }
```

- [ ] **Step 4: Run, verify pass**

Run: `./gradlew test --tests org.osi.server.analytics.DendroCalibrationTest`
Expected: PASS (all, including existing absolute-classification tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/DendroCalibration.java \
        backend/src/test/java/org/osi/server/analytics/DendroCalibrationTest.java
git commit -m "feat(dendro): add relative thresholds + classifyRelative"
```

---

## Task 4: DB-backed calibration entity, repository, service (with in-code fallback)

**Files:**
- Create: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroCalibrationEntity.java`
- Create: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroCalibrationRepository.java`
- Create: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroCalibrationService.java`
- Test: `osi-server/backend/src/test/java/org/osi/server/analytics/DendroCalibrationServiceTest.java`

- [ ] **Step 1: Create the entity**

```java
package org.osi.server.analytics;

import jakarta.persistence.*;
import lombok.*;
import java.time.Instant;

@Entity
@Table(name = "dendro_calibrations")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DendroCalibrationEntity {

    @Id
    @Column(name = "cal_key", length = 40)
    private String calKey;

    @Column(name = "crop", nullable = false, length = 60)
    private String crop;

    @Column(name = "twd_method", nullable = false, length = 20)
    @Builder.Default
    private String twdMethod = "stepwise";

    @Column(name = "rel_mild", nullable = false)        private double relMild;
    @Column(name = "rel_moderate", nullable = false)    private double relModerate;
    @Column(name = "rel_significant", nullable = false) private double relSignificant;
    @Column(name = "rel_severe", nullable = false)      private double relSevere;

    @Column(name = "abs_mild_um", nullable = false)        private double absMildUm;
    @Column(name = "abs_moderate_um", nullable = false)    private double absModerateUm;
    @Column(name = "abs_significant_um", nullable = false) private double absSignificantUm;
    @Column(name = "abs_severe_um", nullable = false)      private double absSevereUm;

    @Column(name = "twd_max_calibrated_um") private Double twdMaxCalibratedUm;
    @Column(name = "psi_a") private Double psiA;
    @Column(name = "psi_b") private Double psiB;

    @Column(name = "updated_at") private Instant updatedAt;

    @PrePersist @PreUpdate
    void touch() { updatedAt = Instant.now(); }

    /** Map this row to the in-memory {@link DendroCalibration} value object. */
    DendroCalibration toCalibration() {
        DendroCalibration.PsiModel psi =
                (psiA != null && psiB != null) ? new DendroCalibration.PsiModel("logistic", psiA, psiB) : null;
        return new DendroCalibration(
                crop, twdMethod, twdMaxCalibratedUm,
                new DendroCalibration.Thresholds(absMildUm, absModerateUm, absSignificantUm, absSevereUm),
                new DendroCalibration.Thresholds(relMild, relModerate, relSignificant, relSevere),
                psi);
    }
}
```

- [ ] **Step 2: Create the repository**

```java
package org.osi.server.analytics;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface DendroCalibrationRepository extends JpaRepository<DendroCalibrationEntity, String> {
    Optional<DendroCalibrationEntity> findByCalKey(String calKey);
}
```

- [ ] **Step 3: Write failing service test**

```java
package org.osi.server.analytics;

import org.junit.jupiter.api.Test;
import java.util.Optional;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class DendroCalibrationServiceTest {

    private final DendroCalibrationRepository repo = mock(DendroCalibrationRepository.class);
    private final DendroCalibrationService service = new DendroCalibrationService(repo);

    @Test
    void forKey_dbHit_usesDbRow() {
        DendroCalibrationEntity row = DendroCalibrationEntity.builder()
                .calKey("apple").crop("apple").twdMethod("stepwise")
                .relMild(0.1).relModerate(0.2).relSignificant(0.3).relSevere(0.4)
                .absMildUm(1).absModerateUm(2).absSignificantUm(3).absSevereUm(4)
                .build();
        when(repo.findByCalKey("apple")).thenReturn(Optional.of(row));

        DendroCalibration cal = service.forKey("apple");

        assertThat(cal.stressThresholdsRelative().severe()).isEqualTo(0.4);
    }

    @Test
    void forKey_dbMiss_fallsBackToBuiltIn() {
        when(repo.findByCalKey("apple")).thenReturn(Optional.empty());

        DendroCalibration cal = service.forKey("apple");

        // built-in apple severe relative threshold
        assertThat(cal.stressThresholdsRelative().severe()).isEqualTo(2.8);
    }

    @Test
    void forKey_unknownKey_fallsBackToDefaultBuiltIn() {
        when(repo.findByCalKey("walnut")).thenReturn(Optional.empty());
        assertThat(service.forKey("walnut").cropOrSpecies()).isEqualTo("default");
    }
}
```

- [ ] **Step 4: Run, verify failure**

Run: `./gradlew test --tests org.osi.server.analytics.DendroCalibrationServiceTest`
Expected: FAIL — `DendroCalibrationService` does not exist.

- [ ] **Step 5: Create the service**

```java
package org.osi.server.analytics;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Resolves a {@link DendroCalibration} for a zone calibration key, preferring the
 * DB-backed {@code dendro_calibrations} row and falling back to the in-code built-ins
 * (so an unseeded table never regresses behavior).
 */
@Service
@RequiredArgsConstructor
public class DendroCalibrationService {

    private final DendroCalibrationRepository repository;

    @Transactional(readOnly = true)
    public DendroCalibration forKey(String key) {
        String normalized = (key == null || key.isBlank()) ? "default" : key.toLowerCase().trim();
        return repository.findByCalKey(normalized)
                .map(DendroCalibrationEntity::toCalibration)
                .orElseGet(() -> DendroCalibration.forKey(normalized));
    }
}
```

- [ ] **Step 6: Run, verify pass**

Run: `./gradlew test --tests org.osi.server.analytics.DendroCalibrationServiceTest`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/DendroCalibrationEntity.java \
        backend/src/main/java/org/osi/server/analytics/DendroCalibrationRepository.java \
        backend/src/main/java/org/osi/server/analytics/DendroCalibrationService.java \
        backend/src/test/java/org/osi/server/analytics/DendroCalibrationServiceTest.java
git commit -m "feat(dendro): DB-backed calibration service with built-in fallback"
```

---

## Task 5: `EnvelopeTwd` anchor-eligibility + growth-rate guard

**Files:**
- Modify: `osi-server/backend/src/main/java/org/osi/server/analytics/EnvelopeTwd.java`
- Test: `osi-server/backend/src/test/java/org/osi/server/analytics/EnvelopeTwdTest.java` (create if absent; otherwise append)

- [ ] **Step 1: Write failing tests**

```java
package org.osi.server.analytics;

import org.junit.jupiter.api.Test;
import java.time.LocalDate;
import java.util.List;
import static org.assertj.core.api.Assertions.*;

class EnvelopeTwdAnchorGuardTest {

    private static EnvelopeTwd.DailyPoint pt(int dayOffset, double dMax, double dMin, boolean eligible) {
        return new EnvelopeTwd.DailyPoint(LocalDate.of(2026, 6, 1).plusDays(dayOffset), dMax, dMin, eligible);
    }

    @Test
    void implausibleSpike_doesNotBecomeAnchor() {
        // Day 0 baseline 1000; day 1 spikes to 5000 (implausible, > maxGrowth); day 2 normal 1010.
        List<EnvelopeTwd.DailyPoint> pts = List.of(
                pt(0, 1000, 980, true),
                pt(1, 5000, 980, true),   // artifact
                pt(2, 1010, 990, true));
        // maxGrowth = 150 µm/day
        List<EnvelopeTwd.EnvelopeResult> r = EnvelopeTwd.compute(pts, "stepwise", 150.0);

        // The spike must NOT have raised the envelope reference.
        assertThat(r.get(2).envelopeRef()).isLessThan(2000.0);
        assertThat(r.get(1).isNewMax()).isFalse();
    }

    @Test
    void lowConfidenceDay_cannotSetAnchor() {
        List<EnvelopeTwd.DailyPoint> pts = List.of(
                pt(0, 1000, 980, true),
                pt(1, 1100, 980, false),  // higher but ineligible
                pt(2, 1050, 990, true));
        List<EnvelopeTwd.EnvelopeResult> r = EnvelopeTwd.compute(pts, "stepwise", 150.0);
        assertThat(r.get(1).isNewMax()).isFalse();
        assertThat(r.get(2).envelopeRef()).isEqualTo(1050.0); // day 2 is the new eligible max
    }

    @Test
    void legacyCompute_twoArg_behavesAsBefore_allEligibleNoGrowthCap() {
        List<EnvelopeTwd.DailyPoint> pts = List.of(
                pt(0, 1000, 980, true),
                pt(1, 5000, 980, true));
        List<EnvelopeTwd.EnvelopeResult> r = EnvelopeTwd.compute(pts, "stepwise");
        assertThat(r.get(1).isNewMax()).isTrue(); // no guard in legacy overload
    }
}
```

- [ ] **Step 2: Run, verify failure**

Run: `./gradlew test --tests org.osi.server.analytics.EnvelopeTwdAnchorGuardTest`
Expected: FAIL — 4-arg `DailyPoint` and 3-arg `compute` do not exist.

- [ ] **Step 3: Extend `DailyPoint` with eligibility + add guarded `compute` overload.**

Replace the `DailyPoint` record with:

```java
    public record DailyPoint(LocalDate date, double dMax, double dMin, boolean anchorEligible) {
        /** Backward-compatible constructor: all days anchor-eligible. */
        public DailyPoint(LocalDate date, double dMax, double dMin) {
            this(date, dMax, dMin, true);
        }
        /** Maximum Daily Shrinkage = D_max − D_min. */
        public double mds() { return dMax - dMin; }
    }
```

Add the legacy 2-arg overload and update the anchor pass. Replace the existing `compute(List<DailyPoint>, String)` method signature/body opening so there are two entry points:

```java
    /** Legacy entry point: every day is anchor-eligible, no growth cap. */
    public static List<EnvelopeResult> compute(List<DailyPoint> points, String method) {
        return compute(points, method, Double.POSITIVE_INFINITY);
    }

    /**
     * @param maxGrowthUmPerDay reject a new running-max anchor when the implied daily
     *        growth from the previous anchor exceeds this bound (artifact guard).
     *        Use {@code Double.POSITIVE_INFINITY} to disable.
     */
    public static List<EnvelopeResult> compute(List<DailyPoint> points, String method, double maxGrowthUmPerDay) {
        if (points == null || points.isEmpty()) return Collections.emptyList();
        int n = points.size();

        // ── Pass 1: anchor indices, guarded by eligibility + plausible growth rate ──
        List<Integer> anchors = new ArrayList<>();
        double runningMax = Double.NEGATIVE_INFINITY;
        Integer lastAnchorIdx = null;

        for (int i = 0; i < n; i++) {
            DailyPoint p = points.get(i);
            if (p.dMax() <= runningMax) continue;
            if (!p.anchorEligible()) continue;
            if (lastAnchorIdx != null && Double.isFinite(maxGrowthUmPerDay)) {
                DailyPoint prev = points.get(lastAnchorIdx);
                long days = Math.max(1, java.time.temporal.ChronoUnit.DAYS.between(prev.date(), p.date()));
                if (p.dMax() - prev.dMax() > maxGrowthUmPerDay * days) continue; // implausible spike
            }
            runningMax = p.dMax();
            anchors.add(i);
            lastAnchorIdx = i;
        }
        // Guarantee at least one anchor (the first eligible point, else index 0) so the envelope is defined.
        if (anchors.isEmpty()) {
            int seed = 0;
            for (int i = 0; i < n; i++) { if (points.get(i).anchorEligible()) { seed = i; break; } }
            anchors.add(seed);
        }
```

> Keep the remainder of the original method (Pass 2 `buildStepwise`/`buildLinear`, Pass 3 results loop) unchanged — only Pass 1 above is replaced, and the old `for` loop that built `anchors` is removed.

- [ ] **Step 4: Run, verify pass**

Run: `./gradlew test --tests org.osi.server.analytics.EnvelopeTwdAnchorGuardTest`
Expected: PASS. Then run any pre-existing envelope tests: `./gradlew test --tests "org.osi.server.analytics.EnvelopeTwd*"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/EnvelopeTwd.java \
        backend/src/test/java/org/osi/server/analytics/EnvelopeTwdAnchorGuardTest.java
git commit -m "feat(dendro): envelope anchor eligibility + growth-rate guard"
```

---

## Task 6: `SolarWindows` utility (sunrise / solar-noon → extrema windows)

**Files:**
- Create: `osi-server/backend/src/main/java/org/osi/server/analytics/SolarWindows.java`
- Test: `osi-server/backend/src/test/java/org/osi/server/analytics/SolarWindowsTest.java`

- [ ] **Step 1: Write failing tests**

```java
package org.osi.server.analytics;

import org.junit.jupiter.api.Test;
import java.time.LocalDate;
import java.time.ZoneId;
import static org.assertj.core.api.Assertions.*;

class SolarWindowsTest {

    @Test
    void midLatitudeSummer_predawnTracksSunrise_afternoonAfterNoon() {
        // ~47°N (Switzerland) on summer solstice: sunrise ~05:30 local, solar noon ~13:30 local (CEST).
        SolarWindows.ExtremaWindows w = SolarWindows.compute(
                LocalDate.of(2026, 6, 21), 47.0, 8.0, ZoneId.of("Europe/Zurich"));

        // pre-dawn window centered near sunrise (04:00–07:30 plausible band)
        assertThat(w.predawnStartMinutes()).isBetween(4 * 60, 7 * 60);
        assertThat(w.predawnEndMinutes()).isGreaterThan(w.predawnStartMinutes());
        // afternoon window starts after solar noon and before evening
        assertThat(w.afternoonStartMinutes()).isBetween(13 * 60, 16 * 60);
        assertThat(w.afternoonEndMinutes()).isGreaterThan(w.afternoonStartMinutes());
    }

    @Test
    void fallback_whenCoordinatesNull_usesFixedWindows() {
        SolarWindows.ExtremaWindows w = SolarWindows.fixedFallback();
        assertThat(w.predawnStartMinutes()).isEqualTo(5 * 60);
        assertThat(w.predawnEndMinutes()).isEqualTo(7 * 60);
        assertThat(w.afternoonStartMinutes()).isEqualTo(13 * 60);
        assertThat(w.afternoonEndMinutes()).isEqualTo(16 * 60);
    }

    @Test
    void equatorialSite_noonNearMidday() {
        // Uganda ~0.3°N: solar noon close to local clock noon (allowing longitude/timezone offset).
        SolarWindows.ExtremaWindows w = SolarWindows.compute(
                LocalDate.of(2026, 6, 21), 0.3, 32.6, ZoneId.of("Africa/Kampala"));
        assertThat(w.afternoonStartMinutes()).isBetween(12 * 60, 15 * 60);
    }
}
```

- [ ] **Step 2: Run, verify failure**

Run: `./gradlew test --tests org.osi.server.analytics.SolarWindowsTest`
Expected: FAIL — `SolarWindows` does not exist.

- [ ] **Step 3: Implement the utility** (NOAA solar-position approximation; no external dependency)

```java
package org.osi.server.analytics;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;

/**
 * Computes physiologically-aligned extrema windows from solar geometry:
 *   • pre-dawn window (stem rehydrated, D_max) centered on sunrise,
 *   • afternoon window (peak transpiration, D_min) offset after solar noon.
 *
 * Uses the NOAA solar-position approximation. All outputs are local minutes-of-day
 * in the zone's timezone. Falls back to fixed windows when coordinates are unavailable.
 */
public final class SolarWindows {

    private SolarWindows() {}

    /** Window bounds as local minutes-of-day [0, 1440). */
    public record ExtremaWindows(
            int predawnStartMinutes, int predawnEndMinutes,
            int afternoonStartMinutes, int afternoonEndMinutes) {}

    // Offsets (minutes) relative to the solar anchors.
    private static final int PREDAWN_BEFORE_SUNRISE = 60;
    private static final int PREDAWN_AFTER_SUNRISE  = 60;
    private static final int AFTERNOON_AFTER_NOON_START = 60;
    private static final int AFTERNOON_AFTER_NOON_END   = 240;

    /** Current fixed windows (05–07h / 13–16h) used when coordinates are missing. */
    public static ExtremaWindows fixedFallback() {
        return new ExtremaWindows(5 * 60, 7 * 60, 13 * 60, 16 * 60);
    }

    public static ExtremaWindows compute(LocalDate date, Double latDeg, Double lonDeg, ZoneId zone) {
        if (latDeg == null || lonDeg == null || zone == null) return fixedFallback();

        double gamma = 2.0 * Math.PI / 365.0 * (date.getDayOfYear() - 1);
        // Equation of time (minutes) and solar declination (radians) — NOAA Fourier approximation.
        double eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
                - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
        double decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
                - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
                - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);

        // Timezone offset (hours) for this date.
        ZonedDateTime zdt = date.atStartOfDay(zone);
        double tzOffsetHours = zdt.getOffset().getTotalSeconds() / 3600.0;

        // Solar noon (local minutes): 720 − 4*lon − eqTime + tz*60.
        double solarNoonMin = 720.0 - 4.0 * lonDeg - eqTime + tzOffsetHours * 60.0;

        // Sunrise hour angle (degrees); guard polar day/night with clamp.
        double latRad = Math.toRadians(latDeg);
        double cosH = -Math.tan(latRad) * Math.tan(decl);
        double sunriseMin;
        if (cosH >= 1.0) {        // polar night → no sunrise; degrade to fixed
            return fixedFallback();
        } else if (cosH <= -1.0) { // polar day → sun always up; anchor pre-dawn at solar midnight+ fixed
            sunriseMin = solarNoonMin - 12 * 60;
        } else {
            double haDeg = Math.toDegrees(Math.acos(cosH));
            sunriseMin = solarNoonMin - 4.0 * haDeg;
        }

        return new ExtremaWindows(
                clampMinute((int) Math.round(sunriseMin) - PREDAWN_BEFORE_SUNRISE),
                clampMinute((int) Math.round(sunriseMin) + PREDAWN_AFTER_SUNRISE),
                clampMinute((int) Math.round(solarNoonMin) + AFTERNOON_AFTER_NOON_START),
                clampMinute((int) Math.round(solarNoonMin) + AFTERNOON_AFTER_NOON_END));
    }

    private static int clampMinute(int m) {
        if (m < 0) return 0;
        if (m > 1439) return 1439;
        return m;
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `./gradlew test --tests org.osi.server.analytics.SolarWindowsTest`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/SolarWindows.java \
        backend/src/test/java/org/osi/server/analytics/SolarWindowsTest.java
git commit -m "feat(dendro): solar-geometry extrema windows utility"
```

---

## Task 7: Wire solar windows into extrema extraction

**Files:**
- Modify: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java`

> The current `extractExtremes` hardcodes `h >= 5 && h < 7` and `h >= 13 && h < 16`. Replace the hour checks with `ExtremaWindows` minute bounds and pass the windows from the per-zone computation.

- [ ] **Step 1: Change `extractExtremes` to accept windows.** Replace the method signature and the two `if (h …)` blocks:

Old signature:
```java
    private ExtractedExtremes extractExtremes(List<double[]> timePos,
                                               List<Double> filtPos, ZoneId tz) {
```
New signature:
```java
    private ExtractedExtremes extractExtremes(List<double[]> timePos,
                                               List<Double> filtPos, ZoneId tz,
                                               SolarWindows.ExtremaWindows win) {
```

Old window logic:
```java
            int h = local.getHour();

            if (h >= 5 && h < 7) {
                predawnSamples++;
                if (pos > pdMax) { pdMax = pos; dMaxTime = local.format(TIME_FMT); }
            }
            if (h >= 13 && h < 16) {
                afternoonSamples++;
                if (pos < afMin) { afMin = pos; dMinTime = local.format(TIME_FMT); }
            }
```
New window logic:
```java
            int minuteOfDay = local.getHour() * 60 + local.getMinute();

            if (minuteOfDay >= win.predawnStartMinutes() && minuteOfDay < win.predawnEndMinutes()) {
                predawnSamples++;
                if (pos > pdMax) { pdMax = pos; dMaxTime = local.format(TIME_FMT); }
            }
            if (minuteOfDay >= win.afternoonStartMinutes() && minuteOfDay < win.afternoonEndMinutes()) {
                afternoonSamples++;
                if (pos < afMin) { afMin = pos; dMinTime = local.format(TIME_FMT); }
            }
```

- [ ] **Step 2: Compute windows once per device call and pass them.** `computeForDevice` needs the zone coordinates. Thread an `ExtremaWindows` parameter through.

In `computeForDevice` signature, add a parameter:
```java
    private TreeResult computeForDevice(Device device, LocalDate today,
                                        Instant windowStart, Instant windowEndExclusive,
                                        ZoneId tz,
                                        DendroCalibration cal, double phenoMod,
                                        Double currentVpdMaxKpa,
                                        SolarWindows.ExtremaWindows extremaWindows) {
```

Update the `extractExtremes` call inside `computeForDevice`:
```java
        ExtractedExtremes ex = extractExtremes(deJumped, filtPos, tz, extremaWindows);
```

- [ ] **Step 3: Build windows in `computeForZone` and pass to the stream.** After `LocalDate today = dayWindow.date();` add:
```java
        SolarWindows.ExtremaWindows extremaWindows =
                SolarWindows.compute(today, zone.getLatitude(), zone.getLongitude(), tz);
```
Update the `devices.stream().map(...)` call to pass it:
```java
        List<TreeResult> trees = devices.stream()
                .map(d -> computeForDevice(
                        d, today, dayWindow.windowStartInclusive(), dayWindow.windowEndExclusive(),
                        tz, cal, phenoMod, vpdMaxKpa, extremaWindows))
                .collect(Collectors.toList());
```

- [ ] **Step 4: Compile + run the analytics scenario test**

Run: `./gradlew test --tests org.osi.server.analytics.DendroAnalyticsScenarioTest`
Expected: PASS (existing scenarios use coordinates or tolerate fixed-fallback; if a scenario asserted exact pre-dawn hours, update it to the new window source).

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java
git commit -m "feat(dendro): solar-geometry extrema windows in extraction"
```

---

## Task 8: Self-calibrated normalization (TWD_rel) + guarded envelope wiring

**Files:**
- Modify: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java`

> Adds `A_ref`-normalized classification with absolute-µm warm-up fallback, persists `twd_rel`, and feeds anchor-eligibility + growth cap into the envelope.

- [ ] **Step 1: Add a constant + `twdRel` to `TreeResult`.** Near the other constants:
```java
    /** Max plausible per-day growth of the envelope reference (µm/day) — artifact guard. */
    private static final double MAX_ANCHOR_GROWTH_UM_PER_DAY = 150.0;
```
In the `TreeResult` class, add a field next to `twdNightUm, twdDayUm`:
```java
        Double twdRel;
```

- [ ] **Step 2: Feed eligibility + growth cap into the envelope.** In `computeForDevice`, the sequence is built from history and today. Replace the today-append and `compute` call.

Old:
```java
        // Append today
        sequence.add(new EnvelopeTwd.DailyPoint(today, t.dMaxUm, t.dMinUm));

        // Run envelope computation using the calibration's preferred method
        List<EnvelopeTwd.EnvelopeResult> envResults =
                EnvelopeTwd.compute(sequence, cal.twdMethod());
```
New:
```java
        // Append today — today is anchor-eligible only when it is a good-confidence day.
        sequence.add(new EnvelopeTwd.DailyPoint(today, t.dMaxUm, t.dMinUm, !t.lowConfidence));

        // Run envelope computation with the calibration method + artifact growth guard.
        List<EnvelopeTwd.EnvelopeResult> envResults =
                EnvelopeTwd.compute(sequence, cal.twdMethod(), MAX_ANCHOR_GROWTH_UM_PER_DAY);
```

> Historical points built earlier in the method use the 3-arg `DailyPoint` constructor (all eligible). To also guard history, change the history mapping to mark low-confidence prior days ineligible: in the `sequence` builder, replace
> `.map(d -> new EnvelopeTwd.DailyPoint(d.getDate(), d.getDMaxUm(), d.getDMinUm()))`
> with
> `.map(d -> new EnvelopeTwd.DailyPoint(d.getDate(), d.getDMaxUm(), d.getDMinUm(), d.getLowConfidenceDay() == 0))`.

- [ ] **Step 3: Compute `TWD_rel` and classify on it with warm-up fallback.** Replace the v5 classification block (Step 9 in the method):

Old:
```java
        // ── Step 9: v5 stress classification (absolute TWD, calibration-based) ─
        if (t.lowConfidence) {
            // Carry forward last good state from yesterday, or "unknown"
            t.treeStateV5 = carryForwardState(yest);
            t.stressLevel = t.treeStateV5;
        } else {
            t.treeStateV5 = cal.classify(t.twdDayUm != null ? t.twdDayUm : 0.0, phenoMod);
            t.stressLevel = t.treeStateV5;
        }
        applyVpdStressAdjustment(t, currentVpdMaxKpa);
```
New:
```java
        // ── Step 9: v6 stress classification ──────────────────────────────────
        //   Primary: TWD_rel = TWD_day / A_ref (self-calibrated, transferable).
        //   Warm-up fallback: absolute µm thresholds until A_ref (baseline) exists.
        double twdDay = t.twdDayUm != null ? t.twdDayUm : 0.0;
        if (t.mdsMaxReferenceUm != null && t.mdsMaxReferenceUm > 0) {
            t.twdRel = round(twdDay / t.mdsMaxReferenceUm, 3);
        }
        if (t.lowConfidence) {
            t.treeStateV5 = carryForwardState(yest);
            t.stressLevel = t.treeStateV5;
        } else if (t.twdRel != null) {
            t.treeStateV5 = cal.classifyRelative(t.twdRel, phenoMod);
            t.stressLevel = t.treeStateV5;
        } else {
            // baseline warm-up — behave exactly as v5
            t.treeStateV5 = cal.classify(twdDay, phenoMod);
            t.stressLevel = t.treeStateV5;
        }
        applyVpdStressAdjustment(t, currentVpdMaxKpa);
```

- [ ] **Step 4: Persist `twd_rel`.** In `saveTree`, after `d.setTreeStateV5(...)`, add:
```java
        d.setTwdRel(t.twdRel);
```

- [ ] **Step 5: Expose `twd_rel` in the per-tree recommendation JSON.** In `buildTreeRecommendationEntry`, add an entry next to `twd_day_um`:
```java
                entry("twd_rel", tree.twdRel),
```

- [ ] **Step 6: Compile + run analytics tests**

Run: `./gradlew test --tests "org.osi.server.analytics.DendroAnalytics*"`
Expected: PASS. Scenarios that asserted absolute-µm stress levels for baseline-complete trees may now classify via `TWD_rel`; update those expectations to the relative thresholds where the baseline is complete (warm-up trees are unchanged).

- [ ] **Step 7: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java
git commit -m "feat(dendro): self-calibrated TWD_rel classification with warm-up fallback"
```

---

## Task 9: Use the DB-backed calibration service in the analytics service

**Files:**
- Modify: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java`

- [ ] **Step 1: Inject the service.** Add to the constructor-injected fields (the `@RequiredArgsConstructor` field block):
```java
    private final DendroCalibrationService dendroCalibrationService;
```

- [ ] **Step 2: Replace the static lookup.** In `computeForZone`, change:
```java
        DendroCalibration cal = DendroCalibration.forKey(zone.getCalibrationKey());
```
to:
```java
        DendroCalibration cal = dendroCalibrationService.forKey(zone.getCalibrationKey());
```

- [ ] **Step 3: Compile + run the full analytics package tests**

Run: `./gradlew test --tests "org.osi.server.analytics.*"`
Expected: PASS. (Tests that construct `DendroAnalyticsService` directly must add the new constructor arg — pass a `DendroCalibrationService` backed by a mocked repository, or `new DendroCalibrationService(mock(DendroCalibrationRepository.class))` which falls back to built-ins.)

- [ ] **Step 4: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java \
        backend/src/test/java/org/osi/server/analytics/*.java
git commit -m "feat(dendro): resolve calibration via DB-backed service"
```

---

## Task 10: Confidence gating fix — `insufficient` data cannot drive irrigation

**Files:**
- Modify: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java`
- Modify: `osi-server/backend/src/main/java/org/osi/server/analytics/DailyQaFlags.java`
- Test: `osi-server/backend/src/test/java/org/osi/server/analytics/DailyQaFlagsTest.java` (create if absent)

- [ ] **Step 1: Raise the day-level floor.** In `DailyQaFlags.java`, change the minimum-samples constant:
```java
    /** Minimum valid readings required across the full day. */
    public static final int    MIN_SAMPLES_DAY        = 30;
```
> Rationale: at the expected ~10-min cadence (~144/day), 30 still tolerates >75% packet loss while ensuring the extrema are represented. This stays below the `insufficient` dataQuality boundary (60) so warm-up isn't over-aggressive.

- [ ] **Step 2: Write a failing test asserting `insufficient` dataQuality forces low confidence.** In a new `DailyQaFlagsTest` (or append to an existing one), the gating itself lives in the service, so test the service rule via a focused unit. Add to `DendroAnalyticsScenarioTest` a scenario (or a new `DendroConfidenceGatingTest`) — minimal direct check:

```java
package org.osi.server.analytics;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class DendroConfidenceGatingTest {
    @Test
    void insufficientDataQuality_impliesLowConfidence_viaSampleFloor() {
        // 20 valid samples < MIN_SAMPLES_DAY(30) → low-confidence day.
        DailyQaFlags flags = DailyQaFlags.build(20, 10, 10, false, 50.0);
        assertThat(flags.lowConfidenceDay()).isTrue();
    }

    @Test
    void sufficientSamplesButInsufficientQualityBand_stillClassifiableButFlagged() {
        // 45 valid samples ≥ 30 floor but < 60 ("insufficient" dataQuality band).
        DailyQaFlags flags = DailyQaFlags.build(45, 10, 10, false, 50.0);
        assertThat(flags.lowConfidenceDay()).isFalse(); // QA alone OK …
    }
}
```

- [ ] **Step 2b: Run, verify the first test passes and the second documents current behavior**

Run: `./gradlew test --tests org.osi.server.analytics.DendroConfidenceGatingTest`
Expected: PASS (first via the raised floor; second is the baseline before the service rule).

- [ ] **Step 3: Make the service treat `insufficient` dataQuality as low-confidence.** In `computeForDevice`, the `dataQuality` is set, then QA flags computed. After the QA-flag assignment (`t.lowConfidence = t.qaFlags.lowConfidenceDay();`), add a unification line:

Old:
```java
        t.lowConfidence   = t.qaFlags.lowConfidenceDay();
        t.confidenceScore = t.qaFlags.confidenceScore();
```
New:
```java
        t.lowConfidence   = t.qaFlags.lowConfidenceDay() || "insufficient".equals(t.dataQuality);
        t.confidenceScore = t.qaFlags.confidenceScore();
```

> Note: the early-return branch (`validReadingsCount < MIN_SAMPLES_DAY`) already sets `lowConfidence = true`; this line covers the band `MIN_SAMPLES_DAY ≤ count < 60` where `dataQuality == "insufficient"`.

- [ ] **Step 4: Run analytics tests**

Run: `./gradlew test --tests "org.osi.server.analytics.*"`
Expected: PASS. (A scenario that relied on a 40–59-sample day driving a stress decision must be updated — such days now propagate last-good state instead.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/DailyQaFlags.java \
        backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java \
        backend/src/test/java/org/osi/server/analytics/DendroConfidenceGatingTest.java
git commit -m "feat(dendro): unify confidence gating — insufficient data cannot drive irrigation"
```

---

## Task 11: Recovery + VPD logic on `TWD_rel` (consistency with the v6 classifier)

**Files:**
- Modify: `osi-server/backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java`

> Replace `mdsNorm`/`MDS_ref` criteria with `TWD_rel`-based criteria so recovery and VPD adjustment use the same signal the classifier now uses. `TreeResult.twdRel` (Task 8) is the shared input.

- [ ] **Step 1: Recovery verification on `TWD_rel`.** In `updateRecoveryVerification`, replace the `verifiable`/`passed` block.

Old:
```java
        List<TreeResult> verifiable = nonRef.stream()
                .filter(t -> !t.isRef)
                .filter(t -> t.baselineComplete)
                .filter(t -> !t.lowConfidence)
                .filter(t -> t.twdNightUm != null)
                .filter(t -> t.mdsNorm != null)
                .toList();

        boolean passed = !verifiable.isEmpty() && verifiable.stream()
                .allMatch(t -> t.twdNightUm < recoveryThreshold &&
                               t.mdsNorm > 0.7 &&
                               (t.recoveryRatioSmoothed == null || t.recoveryRatioSmoothed > 0.8));
```
New:
```java
        // Recovery passes when every verifiable tree's relative deficit has fallen
        // below the calibration's mild ratio (scaled by phenology) and is not low-confidence.
        double mildRel = cal.stressThresholdsRelative().mild() * effectivePhenoMod;

        List<TreeResult> verifiable = nonRef.stream()
                .filter(t -> !t.isRef)
                .filter(t -> t.baselineComplete)
                .filter(t -> !t.lowConfidence)
                .filter(t -> t.twdRel != null)
                .toList();

        boolean passed = !verifiable.isEmpty() && verifiable.stream()
                .allMatch(t -> t.twdRel < mildRel &&
                               (t.recoveryRatioSmoothed == null || t.recoveryRatioSmoothed > 0.8));
```

> The local `recoveryThreshold` (absolute µm) is now unused in this method — remove its declaration line `double recoveryThreshold = cal.stressThresholdsAbsoluteUm().mild() * effectivePhenoMod;` to avoid an unused-variable warning.

- [ ] **Step 2: VPD adjustment on `TWD_rel`.** In `applyVpdStressAdjustment`, replace the `MDS_ref`-relative comparisons with `TWD_rel` band checks.

Old:
```java
        if (tree.lowConfidence || vpdMaxKpa == null || tree.twdNightUm == null || tree.mdsMaxReferenceUm == null) {
            return;
        }
        if (vpdMaxKpa > 2.0 && tree.twdNightUm < tree.mdsMaxReferenceUm * 0.5) {
            tree.treeStateV5 = adjustStress(tree.treeStateV5, -1);
            tree.stressLevel = tree.treeStateV5;
            tree.stressAdjustment = "vpd_downgrade";
        } else if (vpdMaxKpa < 1.0 && tree.twdNightUm > tree.mdsMaxReferenceUm * 0.8) {
            tree.treeStateV5 = adjustStress(tree.treeStateV5, 1);
            tree.stressLevel = tree.treeStateV5;
            tree.stressAdjustment = "vpd_upgrade";
        }
```
New:
```java
        if (tree.lowConfidence || vpdMaxKpa == null || tree.twdRel == null) {
            return;
        }
        // High evaporative demand with only a modest relative deficit → demand-driven, downgrade.
        if (vpdMaxKpa > 2.0 && tree.twdRel < 0.5) {
            tree.treeStateV5 = adjustStress(tree.treeStateV5, -1);
            tree.stressLevel = tree.treeStateV5;
            tree.stressAdjustment = "vpd_downgrade";
        // Low demand yet a large relative deficit → soil-driven stress, upgrade.
        } else if (vpdMaxKpa < 1.0 && tree.twdRel > 0.8) {
            tree.treeStateV5 = adjustStress(tree.treeStateV5, 1);
            tree.stressLevel = tree.treeStateV5;
            tree.stressAdjustment = "vpd_upgrade";
        }
```

- [ ] **Step 3: Compile + run the full analytics suite**

Run: `./gradlew test --tests "org.osi.server.analytics.*"`
Expected: PASS. Update any recovery/VPD scenario assertions that encoded the old `mdsNorm`/`MDS_ref` thresholds to the `TWD_rel` equivalents.

- [ ] **Step 4: Run the whole backend test suite once**

Run: `./gradlew test`
Expected: `BUILD SUCCESSFUL`. Investigate any failure before committing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java \
        backend/src/test/java/org/osi/server/analytics/*.java
git commit -m "feat(dendro): recovery + VPD adjustment on TWD_rel"
```

---

## Task 12 (osi-os, optional): default the LSN50 5V warm-up to 3000 ms for dendrometer devices

**Files:**
- Modify: `osi-os/web/react-gui/src/components/farming/DraginoSettingsModal.tsx`

> The 5V warm-up downlink already exists (`lsn50API.setFiveVoltWarmup`). This only pre-fills 3000 ms as the recommended default for dendrometer-mode LSN50s, so operators don't leave it at 0. No server/firmware change.

- [ ] **Step 1: Add a default constant** near `MAX_LSN50_5V_WARMUP_MS`:
```ts
const DEFAULT_DENDRO_WARMUP_MS = 3000;
```

- [ ] **Step 2: Initialize the warm-up input for dendrometer devices.** Where `warmupMillisecondsInput` is initialized (the `useState('')` at the top of the component), seed it from the device when it is a dendrometer-mode LSN50. Replace:
```ts
  const [warmupMillisecondsInput, setWarmupMillisecondsInput] = useState('');
```
with:
```ts
  const [warmupMillisecondsInput, setWarmupMillisecondsInput] = useState(
    device?.dendroEnabled ? String(DEFAULT_DENDRO_WARMUP_MS) : ''
  );
```
> If `device` does not expose `dendroEnabled` in the GUI type, gate on the existing dendrometer indicator the modal already uses (search the file for how it detects dendrometer mode) rather than adding a new prop.

- [ ] **Step 3: Build the GUI to verify it compiles**

Run (from `osi-os/web/react-gui`): `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit (in the osi-os repo)**

```bash
git add web/react-gui/src/components/farming/DraginoSettingsModal.tsx
git commit -m "feat(gui): default dendrometer LSN50 5V warm-up to 3000 ms"
```

---

## Final verification

- [ ] **Run the full backend suite:** `./gradlew test` → `BUILD SUCCESSFUL`.
- [ ] **Confirm graceful degradation paths are covered by tests:** null `A_ref` → absolute thresholds (Task 8 warm-up branch); null lat/long → fixed windows (Task 6); empty calibration table → built-ins (Task 4).
- [ ] **Backfill (manual, post-deploy):** trigger `DendroController` recompute so historical `dendro_daily` rows gain `twd_rel` and reclassify under v6.

---

## Self-review notes (coverage map)

| Spec item | Task(s) |
|-----------|---------|
| Self-calibrated `TWD_rel` + warm-up fallback | 1, 2, 3, 8 |
| Externalized DB-backed thresholds + built-in fallback | 1, 3, 4, 9 |
| Envelope anchor outlier/growth guard | 5, 8 |
| Solar-geometry extrema windows | 6, 7 |
| Confidence gating fix | 10 |
| Recovery/VPD consistency on `TWD_rel` | 11 |
| LSN50 3 s warm-up companion (osi-os) | 12 |
| Backward-compatibility / additive-only | 1, 2 (+ degradation branches throughout) |
| Testing (TDD) | every task |
