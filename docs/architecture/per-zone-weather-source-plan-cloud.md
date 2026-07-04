# Per-Zone Weather Source — Cloud Implementation Plan (Phases 1–2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each irrigation zone's `weather_source` govern every cloud weather consumer, via a single `WeatherResolver`, adding a MeteoSwiss provider and syncing the field edge→cloud.

**Architecture:** One `WeatherResolver` becomes the sole weather entry point on the cloud; the existing per-provider services (OpenAgri, AgroMonitoring, Open-Meteo) plus S2120-local and a new MeteoSwiss provider sit behind it. Selection is per-zone with transparent fallback to the "auto" cascade and surfaced provenance. Consumers (v6/dendro, ZoneEnvironmentService, PredictionInputAssembler) are refactored to the resolver; an explicit source is authoritative (replaces today's blends), `auto` preserves current behavior exactly.

**Tech Stack:** Java 21, Spring Boot, Spring Data JPA, Flyway (PostgreSQL), Lombok, JUnit5 + AssertJ + Mockito. Build/test from `osi-server/backend`: `./gradlew test` (append `-x buildFrontend -x buildTerraIntelligenceFrontend` if the frontend build is unavailable).

## Global Constraints

- Spec: [per-zone-weather-source-design.md](per-zone-weather-source-design.md). This plan covers the **cloud** only (spec Phases 1–2). The **edge** (spec Phase 3: Node-RED resolve-function + MeteoSwiss fetcher + React source picker/provenance) is a **separate follow-on plan**, authored after this cloud contract lands.
- Source enum values (lowercase strings): `auto`, `local`, `open_meteo`, `openagri`, `agromonitoring`, `meteoswiss`. Default `auto`.
- Behavior invariant: a zone with `weather_source = auto` (all existing zones after migration) must produce **byte-identical** weather behavior to today — same cascades, merges, station blend, caching.
- `auto` cascade order (unchanged): OpenAgri → AgroMonitoring → Open-Meteo.
- Provenance: every resolver result exposes the actual source used; consumers that persist a source label (v6 `vpdSource`) record it.
- All migrations run from `osi-server/backend`. Use a date-based Flyway version to match the repo's recent convention. Commit after each task; branch off `main` (do not commit to `main`).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `db/migration/V2026_07_05_001__add_zone_weather_source.sql` | `irrigation_zones.weather_source` column | Create |
| `zone/IrrigationZone.java` | `weatherSource` field | Modify |
| `analytics/WeatherSource.java` | enum + parse-with-default | Create |
| `analytics/WeatherProvider.java` | uniform provider interface | Create |
| `analytics/OpenAgriWeatherService`/`AgroMonitoringWeatherService`/`OpenMeteoService` | implement `WeatherProvider` | Modify (additive) |
| `analytics/MeteoSwissWeatherService.java` | new CH provider | Create |
| `analytics/WeatherResolver.java` | per-zone selection + fallback + provenance | Create |
| `analytics/DendroAnalyticsService.java` | route through resolver | Modify |
| `analytics/ZoneEnvironmentService.java` | authoritative-source current+forecast | Modify |
| `prediction/PredictionInputAssembler.java` | authoritative-source blend | Modify |
| `sync/EdgeSyncService.java` | accept `weather_source` in `ZONE_CONFIG_UPSERTED` | Modify |

---

## Task 1: Migration — `weather_source` column

**Files:**
- Create: `backend/src/main/resources/db/migration/V2026_07_05_001__add_zone_weather_source.sql`

- [ ] **Step 1: Write the migration**

```sql
-- V2026_07_05_001: per-zone weather source selection. Default 'auto' preserves today's cascade behavior.
ALTER TABLE irrigation_zones ADD COLUMN IF NOT EXISTS weather_source VARCHAR(20) NOT NULL DEFAULT 'auto';
```

- [ ] **Step 2: Compile**

Run: `./gradlew compileJava`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Commit**

```bash
git add backend/src/main/resources/db/migration/V2026_07_05_001__add_zone_weather_source.sql
git commit -m "feat(weather): migration — irrigation_zones.weather_source"
```

---

## Task 2: `WeatherSource` enum + `IrrigationZone.weatherSource`

**Files:**
- Create: `backend/src/main/java/org/osi/server/analytics/WeatherSource.java`
- Modify: `backend/src/main/java/org/osi/server/zone/IrrigationZone.java`
- Test: `backend/src/test/java/org/osi/server/analytics/WeatherSourceTest.java`

**Interfaces:**
- Produces: `WeatherSource` enum `{ AUTO, LOCAL, OPEN_METEO, OPENAGRI, AGROMONITORING, METEOSWISS }`; `WeatherSource.fromKey(String) -> WeatherSource` (unknown/blank/null → `AUTO`); `WeatherSource.key() -> String` (the lowercase persisted value); `IrrigationZone.getWeatherSource()/setWeatherSource(String)` (stored as the raw key string, default `"auto"`).

- [ ] **Step 1: Write failing test**

```java
package org.osi.server.analytics;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class WeatherSourceTest {
    @Test void fromKey_known() {
        assertThat(WeatherSource.fromKey("meteoswiss")).isEqualTo(WeatherSource.METEOSWISS);
        assertThat(WeatherSource.fromKey("open_meteo")).isEqualTo(WeatherSource.OPEN_METEO);
    }
    @Test void fromKey_unknownOrBlank_isAuto() {
        assertThat(WeatherSource.fromKey(null)).isEqualTo(WeatherSource.AUTO);
        assertThat(WeatherSource.fromKey("  ")).isEqualTo(WeatherSource.AUTO);
        assertThat(WeatherSource.fromKey("nope")).isEqualTo(WeatherSource.AUTO);
    }
    @Test void key_roundTrips() {
        assertThat(WeatherSource.fromKey(WeatherSource.OPENAGRI.key())).isEqualTo(WeatherSource.OPENAGRI);
    }
}
```

- [ ] **Step 2: Run, verify fail**

Run: `./gradlew test --tests org.osi.server.analytics.WeatherSourceTest`
Expected: FAIL — `WeatherSource` does not exist.

- [ ] **Step 3: Create the enum**

```java
package org.osi.server.analytics;

/** Per-zone weather source. {@code AUTO} is today's best-available cascade. */
public enum WeatherSource {
    AUTO("auto"),
    LOCAL("local"),
    OPEN_METEO("open_meteo"),
    OPENAGRI("openagri"),
    AGROMONITORING("agromonitoring"),
    METEOSWISS("meteoswiss");

    private final String key;
    WeatherSource(String key) { this.key = key; }
    public String key() { return key; }

    /** Parse a persisted key; unknown/blank/null defaults to {@link #AUTO}. */
    public static WeatherSource fromKey(String key) {
        if (key == null || key.isBlank()) return AUTO;
        String k = key.trim().toLowerCase();
        for (WeatherSource s : values()) if (s.key.equals(k)) return s;
        return AUTO;
    }
}
```

- [ ] **Step 4: Add the field to `IrrigationZone`** — next to the `calibration_key` field:

```java
    @Column(name = "weather_source", length = 20, nullable = false)
    @Builder.Default
    private String weatherSource = "auto";
```

- [ ] **Step 5: Run, verify pass**

Run: `./gradlew test --tests org.osi.server.analytics.WeatherSourceTest`
Expected: PASS. Then `./gradlew compileJava` → `BUILD SUCCESSFUL`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/WeatherSource.java \
        backend/src/main/java/org/osi/server/zone/IrrigationZone.java \
        backend/src/test/java/org/osi/server/analytics/WeatherSourceTest.java
git commit -m "feat(weather): WeatherSource enum + IrrigationZone.weatherSource"
```

---

## Task 3: Sync `weather_source` in `ZONE_CONFIG_UPSERTED`

**Files:**
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`

**Interfaces:**
- Consumes: `IrrigationZone.setWeatherSource(String)`.
- Produces: edge→cloud sync of `weather_source`; unknown values normalized to `auto` on write.

- [ ] **Step 1: Add the mapping** where the zone-config upsert sets `calibration_key`/`crop_type` (near `zone.setCalibrationKey(...)`), add:

```java
        zone.setWeatherSource(
                WeatherSource.fromKey(str(payload, "weather_source", "weatherSource")).key());
```

> Using `WeatherSource.fromKey(...).key()` normalizes any unknown/blank value to `"auto"` defensively. Ensure `org.osi.server.analytics.WeatherSource` is imported.

- [ ] **Step 2: Compile + run the sync tests**

Run: `./gradlew test --tests "org.osi.server.sync.EdgeSyncService*"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/main/java/org/osi/server/sync/EdgeSyncService.java
git commit -m "feat(weather): sync weather_source in ZONE_CONFIG_UPSERTED"
```

---

## Task 4: `WeatherProvider` interface + adapt existing providers

**Files:**
- Create: `backend/src/main/java/org/osi/server/analytics/WeatherProvider.java`
- Modify: `OpenAgriWeatherService.java`, `AgroMonitoringWeatherService.java`, `OpenMeteoService.java` (additive `implements` + one adapter method for the tz-signature mismatch)

**Interfaces:**
- Produces: `interface WeatherProvider { WeatherSource source(); Optional<WeatherSnapshot> getWeatherForDay(double lat, double lon, ZoneId tz, LocalDate day); Optional<WeatherCurrentData> getCurrentConditions(double lat, double lon, ZoneId tz); Optional<WeatherForecastData> getForecast(double lat, double lon, ZoneId tz); }`. The three existing API services implement it (they already have these methods; `OpenAgri`/`AgroMonitoring` `getCurrentConditions` ignore the extra `tz` param).

- [ ] **Step 1: Create the interface**

```java
package org.osi.server.analytics;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Optional;

/** A single weather source behind {@link WeatherResolver}. */
public interface WeatherProvider {
    WeatherSource source();
    Optional<WeatherSnapshot> getWeatherForDay(double latitude, double longitude, ZoneId timezone, LocalDate day);
    Optional<WeatherCurrentData> getCurrentConditions(double latitude, double longitude, ZoneId timezone);
    Optional<WeatherForecastData> getForecast(double latitude, double longitude, ZoneId timezone);
}
```

- [ ] **Step 2: Adapt `OpenMeteoService`** — it already matches. Add `implements WeatherProvider` and:

```java
    @Override public WeatherSource source() { return WeatherSource.OPEN_METEO; }
```

(Its `getCurrentConditions(lat, lon, tz)` and `getForecast(lat, lon, tz)` already satisfy the interface; the extra `getForecast(...,int)` overload is unaffected.)

- [ ] **Step 3: Adapt `OpenAgriWeatherService`** — add `implements WeatherProvider`, `source()` returning `OPENAGRI`, and a tz-taking `getCurrentConditions` overload that delegates to the existing one:

```java
    @Override public WeatherSource source() { return WeatherSource.OPENAGRI; }

    @Override
    public Optional<WeatherCurrentData> getCurrentConditions(double latitude, double longitude, ZoneId timezone) {
        return getCurrentConditions(latitude, longitude);
    }
```

- [ ] **Step 4: Adapt `AgroMonitoringWeatherService`** — same pattern:

```java
    @Override public WeatherSource source() { return WeatherSource.AGROMONITORING; }

    @Override
    public Optional<WeatherCurrentData> getCurrentConditions(double latitude, double longitude, ZoneId timezone) {
        return getCurrentConditions(latitude, longitude);
    }
```

- [ ] **Step 5: Compile**

Run: `./gradlew compileJava`
Expected: `BUILD SUCCESSFUL` (existing callers of the 2-arg `getCurrentConditions` still resolve; the 3-arg is an overload).

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/WeatherProvider.java \
        backend/src/main/java/org/osi/server/analytics/OpenMeteoService.java \
        backend/src/main/java/org/osi/server/analytics/OpenAgriWeatherService.java \
        backend/src/main/java/org/osi/server/analytics/AgroMonitoringWeatherService.java
git commit -m "feat(weather): WeatherProvider interface + adapt existing providers"
```

---

## Task 5: `MeteoSwissWeatherService` (new provider — day path)

**Files:**
- Create: `backend/src/main/java/org/osi/server/analytics/MeteoSwissWeatherService.java`
- Test: `backend/src/test/java/org/osi/server/analytics/MeteoSwissWeatherServiceTest.java`

**Interfaces:**
- Produces: a `WeatherProvider` with `source() == METEOSWISS`; returns `Optional.empty()` outside Swiss coverage or on any fetch/parse failure (so the resolver falls back). Model it on `OpenMeteoService` (same `RestTemplate`/`WeatherProperties` style). It reads MeteoSwiss OGD local-forecasting (STAC) precipitation → `precipitationMm` and derives `vpdMaxKpa` the same way `OpenMeteoService` does, so `WeatherSnapshot` is populated identically in shape. `getCurrentConditions`/`getForecast` may return `Optional.empty()` in this first cut (day path is what v6/dendro needs); the resolver falls back for those.

> Implementation reference: the STAC fetch/nearest-point/param details are documented in `analysis/agroscope-irrigation-assessment/03-weather-pipeline.md` — reproduce the fetch + measured/forecast handling, but NOT its defects (per-row commits, Euclidean nearest without cos(lat), five clock conventions). Keep it stateless and return `Optional.empty()` on any failure.

- [ ] **Step 1: Write failing test** (coverage/empty-path behavior, which is deterministic without network)

```java
package org.osi.server.analytics;

import org.junit.jupiter.api.Test;
import java.time.LocalDate;
import java.time.ZoneOffset;
import static org.assertj.core.api.Assertions.*;

class MeteoSwissWeatherServiceTest {
    private final MeteoSwissWeatherService svc = new MeteoSwissWeatherService();

    @Test void source_isMeteoswiss() {
        assertThat(svc.source()).isEqualTo(WeatherSource.METEOSWISS);
    }

    @Test void outsideSwissCoverage_returnsEmpty() {
        // Kampala, Uganda — well outside CH; must not throw, must return empty (→ resolver fallback).
        assertThat(svc.getWeatherForDay(0.3, 32.6, ZoneOffset.UTC, LocalDate.of(2026, 7, 5))).isEmpty();
    }
}
```

- [ ] **Step 2: Run, verify fail**

Run: `./gradlew test --tests org.osi.server.analytics.MeteoSwissWeatherServiceTest`
Expected: FAIL — class does not exist.

- [ ] **Step 3: Implement the provider.** Mirror `OpenMeteoService`'s structure (constructor, `RestTemplate`, `getWeatherForDay` returning `Optional<WeatherSnapshot>` with `source = "meteoswiss"`). Include a fast `isWithinSwissCoverage(lat, lon)` bounding-box guard (approx CH: lat 45.5–48.0, lon 5.8–10.6) that returns `Optional.empty()` before any network call, and wrap all fetch/parse in try/catch returning `Optional.empty()`. `getCurrentConditions`/`getForecast` return `Optional.empty()` in this cut.

> Provide the full class body following `OpenMeteoService` as the template; the only new logic is the STAC endpoint call + the coverage guard. The test above only exercises the coverage guard, so it passes without network.

- [ ] **Step 4: Run, verify pass**

Run: `./gradlew test --tests org.osi.server.analytics.MeteoSwissWeatherServiceTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/MeteoSwissWeatherService.java \
        backend/src/test/java/org/osi/server/analytics/MeteoSwissWeatherServiceTest.java
git commit -m "feat(weather): MeteoSwiss provider (day path, CH-coverage-guarded)"
```

---

## Task 6: `WeatherResolver` — day path (selection + fallback + provenance)

**Files:**
- Create: `backend/src/main/java/org/osi/server/analytics/WeatherResolver.java`
- Test: `backend/src/test/java/org/osi/server/analytics/WeatherResolverTest.java`

**Interfaces:**
- Consumes: the `WeatherProvider` implementations (OpenAgri, AgroMonitoring, OpenMeteo, MeteoSwiss) + `IrrigationZone`.
- Produces: `Optional<WeatherSnapshot> getWeatherForDay(IrrigationZone zone, LocalDate day)`. Selection: `AUTO` → cascade OpenAgri→AgroMonitoring→OpenMeteo; explicit external source → that provider then the cascade; `LOCAL` and `METEOSWISS`-outside-CH fall through to the cascade. The returned `WeatherSnapshot.source()` is the actual provider's label (provenance is already in `WeatherSnapshot.source`).

- [ ] **Step 1: Write failing tests** (Mockito providers)

```java
package org.osi.server.analytics;

import org.junit.jupiter.api.Test;
import org.osi.server.zone.IrrigationZone;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Optional;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class WeatherResolverTest {
    private final OpenAgriWeatherService openagri = mock(OpenAgriWeatherService.class);
    private final AgroMonitoringWeatherService agro = mock(AgroMonitoringWeatherService.class);
    private final OpenMeteoService openmeteo = mock(OpenMeteoService.class);
    private final MeteoSwissWeatherService meteoswiss = mock(MeteoSwissWeatherService.class);
    private final WeatherResolver resolver = new WeatherResolver(openagri, agro, openmeteo, meteoswiss);

    private IrrigationZone zone(String source) {
        IrrigationZone z = IrrigationZone.builder().build();
        z.setLatitude(47.0); z.setLongitude(8.0); z.setTimezone("Europe/Zurich");
        z.setWeatherSource(source);
        return z;
    }
    private final LocalDate day = LocalDate.of(2026, 7, 5);

    @Test void auto_usesCascadeOpenAgriFirst() {
        when(openagri.getWeatherForDay(anyDouble(), anyDouble(), any(), any()))
                .thenReturn(Optional.of(new WeatherSnapshot(1.0, 0.5, "openagri")));
        assertThat(resolver.getWeatherForDay(zone("auto"), day)).get()
                .extracting(WeatherSnapshot::source).isEqualTo("openagri");
        verifyNoInteractions(meteoswiss);
    }

    @Test void explicit_meteoswiss_used_whenAvailable() {
        when(meteoswiss.getWeatherForDay(anyDouble(), anyDouble(), any(), any()))
                .thenReturn(Optional.of(new WeatherSnapshot(2.0, 0.7, "meteoswiss")));
        assertThat(resolver.getWeatherForDay(zone("meteoswiss"), day)).get()
                .extracting(WeatherSnapshot::source).isEqualTo("meteoswiss");
    }

    @Test void explicit_meteoswiss_fallsBackToCascade_whenEmpty() {
        when(meteoswiss.getWeatherForDay(anyDouble(), anyDouble(), any(), any())).thenReturn(Optional.empty());
        when(openagri.getWeatherForDay(anyDouble(), anyDouble(), any(), any())).thenReturn(Optional.empty());
        when(agro.getWeatherForDay(anyDouble(), anyDouble(), any(), any()))
                .thenReturn(Optional.of(new WeatherSnapshot(3.0, 0.9, "agromonitoring")));
        assertThat(resolver.getWeatherForDay(zone("meteoswiss"), day)).get()
                .extracting(WeatherSnapshot::source).isEqualTo("agromonitoring");
    }

    @Test void local_dayForecast_fallsBackToCascade() {
        when(openagri.getWeatherForDay(anyDouble(), anyDouble(), any(), any()))
                .thenReturn(Optional.of(new WeatherSnapshot(1.0, 0.5, "openagri")));
        assertThat(resolver.getWeatherForDay(zone("local"), day)).get()
                .extracting(WeatherSnapshot::source).isEqualTo("openagri");
    }
}
```

- [ ] **Step 2: Run, verify fail**

Run: `./gradlew test --tests org.osi.server.analytics.WeatherResolverTest`
Expected: FAIL — `WeatherResolver` does not exist.

- [ ] **Step 3: Implement the resolver**

```java
package org.osi.server.analytics;

import lombok.RequiredArgsConstructor;
import org.osi.server.zone.IrrigationZone;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Single per-zone weather entry point. An explicit source is authoritative (tried first, then the auto
 * cascade); {@code auto} is the cascade OpenAgri → AgroMonitoring → Open-Meteo. See the design spec.
 */
@Service
@RequiredArgsConstructor
public class WeatherResolver {

    private final OpenAgriWeatherService openAgri;
    private final AgroMonitoringWeatherService agroMonitoring;
    private final OpenMeteoService openMeteo;
    private final MeteoSwissWeatherService meteoSwiss;

    public Optional<WeatherSnapshot> getWeatherForDay(IrrigationZone zone, LocalDate day) {
        if (zone == null || zone.getLatitude() == null || zone.getLongitude() == null) return Optional.empty();
        double lat = zone.getLatitude(), lon = zone.getLongitude();
        ZoneId tz = parseZone(zone.getTimezone());

        for (WeatherProvider p : dayProviderChain(WeatherSource.fromKey(zone.getWeatherSource()))) {
            Optional<WeatherSnapshot> r = p.getWeatherForDay(lat, lon, tz, day);
            if (r.isPresent()) return r;
        }
        return Optional.empty();
    }

    /** Explicit external source first, then the auto cascade. LOCAL has no day/forecast → cascade only. */
    private List<WeatherProvider> dayProviderChain(WeatherSource selected) {
        List<WeatherProvider> chain = new ArrayList<>();
        switch (selected) {
            case OPEN_METEO -> chain.add(openMeteo);
            case OPENAGRI -> chain.add(openAgri);
            case AGROMONITORING -> chain.add(agroMonitoring);
            case METEOSWISS -> chain.add(meteoSwiss);
            case AUTO, LOCAL -> { /* cascade only */ }
        }
        // Auto cascade (skip any already added to avoid a double-call).
        for (WeatherProvider p : List.of(openAgri, agroMonitoring, openMeteo)) {
            if (!chain.contains(p)) chain.add(p);
        }
        return chain;
    }

    private ZoneId parseZone(String tz) {
        try { return tz != null ? ZoneId.of(tz) : ZoneOffset.UTC; }
        catch (Exception e) { return ZoneOffset.UTC; }
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `./gradlew test --tests org.osi.server.analytics.WeatherResolverTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/WeatherResolver.java \
        backend/src/test/java/org/osi/server/analytics/WeatherResolverTest.java
git commit -m "feat(weather): WeatherResolver day path (selection + fallback + provenance)"
```

---

## Task 7: Route `DendroAnalyticsService` (v6) through the resolver

**Files:**
- Modify: `backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java`

**Interfaces:**
- Consumes: `WeatherResolver.getWeatherForDay(zone, day)`.

- [ ] **Step 1: Inject the resolver.** Add to the `@RequiredArgsConstructor` field block (near `weatherLookupService`):

```java
    private final WeatherResolver weatherResolver;
```

- [ ] **Step 2: Replace the call.** Change (around `DendroAnalyticsService.java:136-137`):

```java
        if (zone.getLatitude() != null && zone.getLongitude() != null && weatherLookupService != null) {
            weather = weatherLookupService.getWeatherForDay(zone.getLatitude(), zone.getLongitude(), tz, today);
```
to:
```java
        if (zone.getLatitude() != null && zone.getLongitude() != null && weatherResolver != null) {
            weather = weatherResolver.getWeatherForDay(zone, today);
```

> `vpdSource` (line 141) already derives from `WeatherSnapshot::source`, so provenance now reflects the resolved provider automatically. Leave `weatherLookupService` injected if still referenced elsewhere; otherwise remove it.

- [ ] **Step 3: Fix direct-construction tests.** Any `new DendroAnalyticsService(...)` in tests must pass a `WeatherResolver` at the matching constructor position (build one with mocked provider services, or `mock(WeatherResolver.class)`). Grep: `grep -rn "new DendroAnalyticsService(" backend/src/test`.

- [ ] **Step 4: Run analytics tests**

Run: `./gradlew test --tests "org.osi.server.analytics.*" -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: PASS (an `auto` zone resolves via the same cascade, so scenario expectations are unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/DendroAnalyticsService.java \
        backend/src/test/java/org/osi/server/analytics/*.java
git commit -m "feat(weather): dendro v6 reads weather via WeatherResolver"
```

---

## Task 8: `WeatherResolver` current+forecast + route `ZoneEnvironmentService`

**Files:**
- Modify: `backend/src/main/java/org/osi/server/analytics/WeatherResolver.java`
- Modify: `backend/src/main/java/org/osi/server/analytics/ZoneEnvironmentService.java`
- Test: extend `WeatherResolverTest`

**Interfaces:**
- Produces: `Optional<WeatherCurrentData> getCurrentConditions(IrrigationZone zone)` and `Optional<WeatherForecastData> getForecast(IrrigationZone zone)`. For `AUTO`, reproduce `ZoneEnvironmentService`'s existing cascade/merge EXACTLY (move that logic behind the resolver, keyed on `AUTO`). For an explicit source, that provider then the cascade. `LOCAL` current = S2120 via the existing local path; `LOCAL` forecast = cascade.

- [ ] **Step 1: Add resolver methods** for current + forecast, mirroring `dayProviderChain` for provider order, and — critically — for `AUTO` reproduce the current `ZoneEnvironmentService` behavior (including the OpenAgri+AgroMonitoring forecast **merge** via the existing `mergeForecasts` logic, which moves into or is invoked by the resolver). Keep `ZoneEnvironmentService`'s caching where it is (the resolver returns fresh values; the service caches them).

- [ ] **Step 2: Refactor `ZoneEnvironmentService`** to obtain current/forecast from `weatherResolver.getCurrentConditions(zone)`/`getForecast(zone)` instead of its inline `.or(...)` chains, passing the zone so the source is honored. Preserve the `edgeCompatible` behavior for `AUTO` (edge-compatible = the OpenAgri→OpenMeteo variant); for an explicit source, `edgeCompatible` is irrelevant (the chosen source wins). Keep the S2120 `LocalEnvironment` path for `LOCAL`.

- [ ] **Step 3: Tests.** Extend `WeatherResolverTest` with current/forecast selection + fallback cases (mirroring the day-path tests). Update `ZoneEnvironmentServiceTest` so an `auto` zone yields identical results to before (assert no behavior change), and an explicit `open_meteo` zone resolves to Open-Meteo.

- [ ] **Step 4: Run**

Run: `./gradlew test --tests "org.osi.server.analytics.*" -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/analytics/WeatherResolver.java \
        backend/src/main/java/org/osi/server/analytics/ZoneEnvironmentService.java \
        backend/src/test/java/org/osi/server/analytics/*.java
git commit -m "feat(weather): resolver current+forecast; ZoneEnvironmentService honors weather_source"
```

---

## Task 9: Route `PredictionInputAssembler` (authoritative source over the blend)

**Files:**
- Modify: `backend/src/main/java/org/osi/server/prediction/PredictionInputAssembler.java`
- Test: `backend/src/test/java/org/osi/server/analytics/ZoneEnvironmentServiceTest.java` neighbors / a prediction assembler test

**Interfaces:**
- Consumes: `WeatherResolver` + the zone's `weather_source`.

- [ ] **Step 1: Thread the source into the blend.** Today the assembler builds `stationWeatherByDate` (S2120), `agroByDate`, and `openMeteoByDate` and blends them. Change the blend so that when `WeatherSource.fromKey(zone.getWeatherSource())` is explicit:
  - `local` → prefer the S2120 station map; fall back to the cascade per day where the station is missing.
  - an explicit external source → use only that source's per-day map (built via the resolver/provider), with cascade fallback per missing day; do NOT fold in the other externals.
  - `auto` → keep today's blend exactly (no change).

> Implement by selecting which per-day map(s) feed the blend based on the source, reusing the existing per-day-map builders. Keep the method's output contract identical.

- [ ] **Step 2: Tests.** Add a focused test: an `auto` zone produces the same assembled inputs as before (guard against regression); an explicit `open_meteo` zone's assembled daily weather comes only from Open-Meteo (+ fallback), not the station/agro blend.

- [ ] **Step 3: Run**

Run: `./gradlew test --tests "org.osi.server.prediction.*" -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/main/java/org/osi/server/prediction/PredictionInputAssembler.java \
        backend/src/test/java/org/osi/server/prediction/*.java
git commit -m "feat(weather): prediction honors authoritative weather_source"
```

---

## Final verification

- [ ] `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend` → `BUILD SUCCESSFUL`.
- [ ] Confirm the `auto` invariant: grep the diff for any place an `auto` zone would take a different path than today; there should be none (cascade/merge/blend preserved for `AUTO`).
- [ ] Manual/integration: set a test zone to each source; confirm the resolved provenance (`vpdSource`, tab source label) matches, and MeteoSwiss outside CH falls back.

---

## Edge (spec Phase 3) — separate plan

Not covered here. The edge work (Node-RED "resolve weather for zone" function + a new edge MeteoSwiss fetcher for full parity + routing `WeatherTab`/`WaterTab` + the React zone-settings source picker and provenance display + persisting/syncing `weather_source`) is a distinct subsystem with an editor-based Node-RED workflow that does not fit code-diff TDD. It gets its own spec-aligned plan authored **after** this cloud contract lands and the `weather_source` sync field is proven end-to-end.

## Self-review (coverage map)

| Spec item | Task |
|-----------|------|
| `weather_source` column + field | 1, 2 |
| enum + default `auto` + unknown→auto | 2 |
| edge→cloud sync of the field | 3 |
| single resolver + pluggable providers | 4, 6, 8 |
| MeteoSwiss provider (CH-only, fallback) | 5 |
| explicit-source-authoritative + `auto` unchanged | 6, 8, 9 |
| `local` = S2120 measured + cascade forecast | 6, 8 |
| provenance surfaced | 6 (via `WeatherSnapshot.source`), 7 |
| consumers routed (v6, ZoneEnvironment, prediction) | 7, 8, 9 |
| edge (Node-RED + React) | separate plan (documented above) |
