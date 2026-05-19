# Chameleon Calibration: Global Table + via.farm Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Chameleon calibration from per-device columns into a global `chameleon_calibrations` table keyed by hardware `array_id`, integrated with via.farm's API on the cloud side and bundled into firmware on the edge side.

**Architecture:** Cache-aside on osi-server (via.farm upstream, Postgres cache, negative-cache for unknown IDs). Lazy fetch + manual refresh on osi-os (SQLite local cache, bundled seed at build time, no outbox UPDATE events). Cloud recomputes historical kPa from mirrored raw resistances + global calibration; edge stays insert-only.

**Tech Stack:** Spring Boot (Java 17) + Postgres on osi-server; Node-RED + SQLite + React on osi-os; via.farm Token-auth REST API.

**Spec:** [docs/superpowers/specs/2026-05-19-chameleon-calibration-global-table-design.md](../specs/2026-05-19-chameleon-calibration-global-table-design.md)

**Repos touched:**
- `/home/phil/Repos/osi-os` (this repo)
- `/home/phil/Repos/osi-server`

**Two-phase execution.** Phase A (osi-server) must land first so the edge has an endpoint to call. Phase B (osi-os) consumes the new endpoints.

---

## File structure

### osi-server (Java / Spring Boot)
- **Create** `backend/src/main/resources/db/migration/V42__chameleon_calibrations.sql` — schema migration
- **Create** `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibration.java` — JPA entity
- **Create** `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationRepository.java`
- **Create** `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationMiss.java`
- **Create** `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationMissRepository.java`
- **Create** `backend/src/main/java/org/osi/server/chameleon/ViaFarmClient.java`
- **Create** `backend/src/main/java/org/osi/server/chameleon/ViaFarmResponse.java`
- **Create** `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsService.java`
- **Create** `backend/src/main/java/org/osi/server/chameleon/SensorIdDerivation.java`
- **Create** `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsController.java`
- **Create** `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsAdminController.java`
- **Create** `backend/src/main/java/org/osi/server/chameleon/ChameleonRecomputeService.java`
- **Create** test files mirroring the above under `backend/src/test/java/org/osi/server/chameleon/`
- **Modify** `backend/src/main/java/org/osi/server/device/DeviceController.java` — delete chameleon-config endpoint
- **Modify** `backend/src/main/java/org/osi/server/device/DeviceService.java` — delete ChameleonConfig nested type
- **Modify** `backend/src/main/resources/application.yml` (or equivalent) — add `via-farm.*` config
- **Modify** `AGENTS.md` and any docs referencing the dropped columns

### osi-os (SQLite + Node-RED + React)
- **Create** `database/migrations/2026-05-19-add-chameleon-calibrations.sql`
- **Create** `database/seeds/chameleon-calibrations.sql` (generated; empty initial commit)
- **Create** `scripts/refresh-chameleon-calibrations.js`
- **Create** `scripts/verify-chameleon-calibration.js`
- **Modify** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`
- **Modify** `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chameleon-helper/index.js`
- **Modify** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (sync worker + edge endpoint + remove old chameleon-config nodes)
- **Modify** `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- **Modify** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db` (seed DB rebuild)
- **Modify** `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
- **Modify** `database/seed-blank.sql`
- **Modify** `web/react-gui/src/services/api.ts` — delete `ChameleonConfigPayload` + `setChameleonConfig`, add refresh endpoint client + per-row history type extension
- **Modify** `web/react-gui/src/types/farming.ts` — drop the 9 calibration coefficient fields, add `calibration_status` to history row types
- **Modify** `web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx` — replace coefficient inputs with read-only status block
- **Modify** `scripts/verify-lsn50-chameleon-persistence.js`
- **Modify** `scripts/verify-sync-flow.js`
- **Modify** `AGENTS.md`
- **Modify** `/home/phil/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md`

---

# PHASE A — osi-server (Java / Spring Boot)

Work in `/home/phil/Repos/osi-server` for all Phase A tasks.

---

### Task A0: Pre-flight checks

**Files:** none

- [ ] **Step 1: Confirm the package layout**

Run:
```bash
cd /home/phil/Repos/osi-server && ls backend/src/main/java/org/osi/server/
```

Expected: `analytics chameleon? command config device gateway mqtt prediction retention security soil sync telemetry user websocket zone` — `chameleon` may not yet exist (that's fine; Task A2 creates it).

- [ ] **Step 2: Confirm latest migration**

```bash
ls backend/src/main/resources/db/migration/ | sort -V | tail -3
```

Expected: ends with `V41__chameleon_data_invalid.sql`. Next migration number is V42.

- [ ] **Step 3: Confirm DeviceController has the soon-to-be-deleted endpoint**

```bash
grep -n "chameleon-config\|ChameleonConfigRequest" backend/src/main/java/org/osi/server/device/DeviceController.java
```

Expected: non-empty output. Note the line numbers; Task A9 deletes them.

- [ ] **Step 4: Confirm test infra**

```bash
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest --quiet
```

Expected: passes. (If not, fix infra before continuing — none of this work happens on a red baseline.)

---

### Task A1: V42 migration — new tables, drop columns, NULL stale device_data

**Files:**
- Create: `backend/src/main/resources/db/migration/V42__chameleon_calibrations.sql`

- [ ] **Step 1: Create the migration SQL**

```sql
-- V42: Chameleon calibration global table + retire per-device coefficients

CREATE TABLE chameleon_calibrations (
    array_id                VARCHAR(16) PRIMARY KEY,
    sensor_id               VARCHAR(4) NOT NULL,
    sensor1_a               DOUBLE PRECISION NOT NULL,
    sensor1_b               DOUBLE PRECISION NOT NULL,
    sensor1_c               DOUBLE PRECISION NOT NULL,
    sensor1_r2              DOUBLE PRECISION,
    sensor2_a               DOUBLE PRECISION NOT NULL,
    sensor2_b               DOUBLE PRECISION NOT NULL,
    sensor2_c               DOUBLE PRECISION NOT NULL,
    sensor2_r2              DOUBLE PRECISION,
    sensor3_a               DOUBLE PRECISION NOT NULL,
    sensor3_b               DOUBLE PRECISION NOT NULL,
    sensor3_c               DOUBLE PRECISION NOT NULL,
    sensor3_r2              DOUBLE PRECISION,
    test_rig_run_start_date TIMESTAMPTZ,
    source                  VARCHAR(16) NOT NULL,
    fetched_at              TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_chameleon_calibrations_sensor_id ON chameleon_calibrations(sensor_id);

CREATE TABLE chameleon_calibration_misses (
    array_id   VARCHAR(16) PRIMARY KEY,
    last_tried TIMESTAMPTZ NOT NULL,
    reason     VARCHAR(32)
);

-- Status column on readings
ALTER TABLE chameleon_readings ADD COLUMN IF NOT EXISTS calibration_status VARCHAR(16);

-- Drop per-device coefficient columns (9 total). Depth + enabled stay.
ALTER TABLE devices DROP COLUMN IF EXISTS chameleon_swt1_a;
ALTER TABLE devices DROP COLUMN IF EXISTS chameleon_swt1_b;
ALTER TABLE devices DROP COLUMN IF EXISTS chameleon_swt1_c;
ALTER TABLE devices DROP COLUMN IF EXISTS chameleon_swt2_a;
ALTER TABLE devices DROP COLUMN IF EXISTS chameleon_swt2_b;
ALTER TABLE devices DROP COLUMN IF EXISTS chameleon_swt2_c;
ALTER TABLE devices DROP COLUMN IF EXISTS chameleon_swt3_a;
ALTER TABLE devices DROP COLUMN IF EXISTS chameleon_swt3_b;
ALTER TABLE devices DROP COLUMN IF EXISTS chameleon_swt3_c;

-- Clear soon-to-be-stale kPa values. On the cloud, computed kPa lives directly on
-- chameleon_readings (per V40 chameleon_full_mirror) — there is no device_data table.
-- Every chameleon_readings row is by definition a chameleon row; no join needed.
UPDATE chameleon_readings SET swt_1 = NULL, swt_2 = NULL, swt_3 = NULL;
```

- [ ] **Step 2: Apply migration (running Postgres)**

```bash
./gradlew flywayMigrate
```

Expected: `Successfully applied 1 migration to schema "public", now at version v42`.

- [ ] **Step 3: Verify schema**

```bash
psql "$DATABASE_URL" -c "\d chameleon_calibrations" -c "\d chameleon_calibration_misses" -c "\d devices" | grep -E "calibration|swt"
```

Expected: new tables present, `devices` has no `chameleon_swt[123]_[abc]` columns, `chameleon_readings.calibration_status` exists.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-server
git add backend/src/main/resources/db/migration/V42__chameleon_calibrations.sql
git commit -m "feat(chameleon): V42 schema — global calibration table, drop per-device coefficients"
```

---

### Task A2: SensorIdDerivation utility + test

**Files:**
- Create: `backend/src/main/java/org/osi/server/chameleon/SensorIdDerivation.java`
- Test: `backend/src/test/java/org/osi/server/chameleon/SensorIdDerivationTest.java`

- [ ] **Step 1: Write the failing test**

```java
package org.osi.server.chameleon;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class SensorIdDerivationTest {
  @Test void derivesFromUppercase() {
    assertEquals("F8C1", SensorIdDerivation.deriveSensorId("28F8B2B40F0000C1"));
  }
  @Test void derivesFromLowercase() {
    assertEquals("F8C1", SensorIdDerivation.deriveSensorId("28f8b2b40f0000c1"));
  }
  @Test void derivesFromMixedCase() {
    assertEquals("DEE2", SensorIdDerivation.deriveSensorId("28dE7eC80B0000e2"));
  }
  @Test void normalizesArrayId() {
    assertEquals("28F8B2B40F0000C1", SensorIdDerivation.normalize("28f8b2b40f0000c1"));
  }
  @Test void rejectsWrongLength() {
    assertThrows(IllegalArgumentException.class,
      () -> SensorIdDerivation.deriveSensorId("28F8B2B40F0000C"));
  }
  @Test void rejectsNonHex() {
    assertThrows(IllegalArgumentException.class,
      () -> SensorIdDerivation.deriveSensorId("28F8B2B40F0000Z1"));
  }
}
```

- [ ] **Step 2: Run, verify fail**

```bash
./gradlew test --tests org.osi.server.chameleon.SensorIdDerivationTest
```

Expected: compile failure (class doesn't exist).

- [ ] **Step 3: Implement**

```java
package org.osi.server.chameleon;

import java.util.regex.Pattern;

public final class SensorIdDerivation {
  private static final Pattern HEX16 = Pattern.compile("^[0-9A-F]{16}$");

  private SensorIdDerivation() {}

  public static String normalize(String arrayId) {
    if (arrayId == null) {
      throw new IllegalArgumentException("array_id is null");
    }
    String upper = arrayId.toUpperCase();
    if (!HEX16.matcher(upper).matches()) {
      throw new IllegalArgumentException("array_id must be 16 hex chars: " + arrayId);
    }
    return upper;
  }

  public static String deriveSensorId(String arrayId) {
    String n = normalize(arrayId);
    return n.substring(2, 4) + n.substring(14, 16);
  }
}
```

- [ ] **Step 4: Run, verify pass**

```bash
./gradlew test --tests org.osi.server.chameleon.SensorIdDerivationTest
```

Expected: 6 tests, all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/chameleon/SensorIdDerivation.java \
        backend/src/test/java/org/osi/server/chameleon/SensorIdDerivationTest.java
git commit -m "feat(chameleon): add SensorIdDerivation utility"
```

---

### Task A3: JPA entity + repository — ChameleonCalibration

**Files:**
- Create: `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibration.java`
- Create: `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationRepository.java`

- [ ] **Step 1: Write the entity**

```java
package org.osi.server.chameleon;

import jakarta.persistence.*;
import java.time.OffsetDateTime;

@Entity
@Table(name = "chameleon_calibrations")
public class ChameleonCalibration {
  @Id
  @Column(name = "array_id", length = 16)
  private String arrayId;

  @Column(name = "sensor_id", length = 4, nullable = false)
  private String sensorId;

  @Column(name = "sensor1_a", nullable = false) private double sensor1A;
  @Column(name = "sensor1_b", nullable = false) private double sensor1B;
  @Column(name = "sensor1_c", nullable = false) private double sensor1C;
  @Column(name = "sensor1_r2") private Double sensor1R2;
  @Column(name = "sensor2_a", nullable = false) private double sensor2A;
  @Column(name = "sensor2_b", nullable = false) private double sensor2B;
  @Column(name = "sensor2_c", nullable = false) private double sensor2C;
  @Column(name = "sensor2_r2") private Double sensor2R2;
  @Column(name = "sensor3_a", nullable = false) private double sensor3A;
  @Column(name = "sensor3_b", nullable = false) private double sensor3B;
  @Column(name = "sensor3_c", nullable = false) private double sensor3C;
  @Column(name = "sensor3_r2") private Double sensor3R2;

  @Column(name = "test_rig_run_start_date") private OffsetDateTime testRigRunStartDate;
  @Column(nullable = false, length = 16) private String source;
  @Column(name = "fetched_at", nullable = false) private OffsetDateTime fetchedAt;

  public String getArrayId() { return arrayId; }
  public void setArrayId(String v) { this.arrayId = v; }
  public String getSensorId() { return sensorId; }
  public void setSensorId(String v) { this.sensorId = v; }
  public double getSensor1A() { return sensor1A; } public void setSensor1A(double v) { this.sensor1A = v; }
  public double getSensor1B() { return sensor1B; } public void setSensor1B(double v) { this.sensor1B = v; }
  public double getSensor1C() { return sensor1C; } public void setSensor1C(double v) { this.sensor1C = v; }
  public Double getSensor1R2() { return sensor1R2; } public void setSensor1R2(Double v) { this.sensor1R2 = v; }
  public double getSensor2A() { return sensor2A; } public void setSensor2A(double v) { this.sensor2A = v; }
  public double getSensor2B() { return sensor2B; } public void setSensor2B(double v) { this.sensor2B = v; }
  public double getSensor2C() { return sensor2C; } public void setSensor2C(double v) { this.sensor2C = v; }
  public Double getSensor2R2() { return sensor2R2; } public void setSensor2R2(Double v) { this.sensor2R2 = v; }
  public double getSensor3A() { return sensor3A; } public void setSensor3A(double v) { this.sensor3A = v; }
  public double getSensor3B() { return sensor3B; } public void setSensor3B(double v) { this.sensor3B = v; }
  public double getSensor3C() { return sensor3C; } public void setSensor3C(double v) { this.sensor3C = v; }
  public Double getSensor3R2() { return sensor3R2; } public void setSensor3R2(Double v) { this.sensor3R2 = v; }
  public OffsetDateTime getTestRigRunStartDate() { return testRigRunStartDate; }
  public void setTestRigRunStartDate(OffsetDateTime v) { this.testRigRunStartDate = v; }
  public String getSource() { return source; } public void setSource(String v) { this.source = v; }
  public OffsetDateTime getFetchedAt() { return fetchedAt; } public void setFetchedAt(OffsetDateTime v) { this.fetchedAt = v; }
}
```

- [ ] **Step 2: Write the repository**

```java
package org.osi.server.chameleon;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface ChameleonCalibrationRepository extends JpaRepository<ChameleonCalibration, String> {
  Optional<ChameleonCalibration> findByArrayId(String arrayId);
}
```

- [ ] **Step 3: Verify compiles**

```bash
./gradlew compileJava
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add backend/src/main/java/org/osi/server/chameleon/ChameleonCalibration.java \
        backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationRepository.java
git commit -m "feat(chameleon): add ChameleonCalibration entity + repository"
```

---

### Task A4: JPA entity + repository — ChameleonCalibrationMiss

**Files:**
- Create: `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationMiss.java`
- Create: `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationMissRepository.java`

- [ ] **Step 1: Write the entity**

```java
package org.osi.server.chameleon;

import jakarta.persistence.*;
import java.time.OffsetDateTime;

@Entity
@Table(name = "chameleon_calibration_misses")
public class ChameleonCalibrationMiss {
  @Id
  @Column(name = "array_id", length = 16)
  private String arrayId;

  @Column(name = "last_tried", nullable = false)
  private OffsetDateTime lastTried;

  @Column(length = 32)
  private String reason;

  public String getArrayId() { return arrayId; }
  public void setArrayId(String v) { this.arrayId = v; }
  public OffsetDateTime getLastTried() { return lastTried; }
  public void setLastTried(OffsetDateTime v) { this.lastTried = v; }
  public String getReason() { return reason; }
  public void setReason(String v) { this.reason = v; }
}
```

- [ ] **Step 2: Write the repository**

```java
package org.osi.server.chameleon;

import org.springframework.data.jpa.repository.JpaRepository;
import java.time.OffsetDateTime;
import java.util.Optional;

public interface ChameleonCalibrationMissRepository
    extends JpaRepository<ChameleonCalibrationMiss, String> {

  Optional<ChameleonCalibrationMiss> findByArrayIdAndLastTriedAfter(
      String arrayId, OffsetDateTime cutoff);
}
```

- [ ] **Step 3: Verify**

```bash
./gradlew compileJava
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationMiss.java \
        backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationMissRepository.java
git commit -m "feat(chameleon): add ChameleonCalibrationMiss entity + repository"
```

---

### Task A5: ViaFarmClient + DTO + tests

**Files:**
- Create: `backend/src/main/java/org/osi/server/chameleon/ViaFarmResponse.java`
- Create: `backend/src/main/java/org/osi/server/chameleon/ViaFarmClient.java`
- Create: `backend/src/main/java/org/osi/server/chameleon/ViaFarmResult.java`
- Test: `backend/src/test/java/org/osi/server/chameleon/ViaFarmClientTest.java`

- [ ] **Step 1: Add via.farm config to application.yml**

Edit `backend/src/main/resources/application.yml` (or `application.properties`) — add at the same level as existing config keys:

```yaml
via-farm:
  base-url: ${VIA_FARM_BASE_URL:https://via.farm/api}
  api-token: ${VIA_FARM_API_TOKEN:}
  timeout-millis: 5000
```

- [ ] **Step 2: Write the response DTO**

```java
package org.osi.server.chameleon;

import com.fasterxml.jackson.annotation.JsonProperty;

public class ViaFarmResponse {
  @JsonProperty("temperature_id_full") public String temperatureIdFull;
  @JsonProperty("test_rig_run_start_date") public String testRigRunStartDate;
  public Double sensor1a, sensor1b, sensor1c;
  @JsonProperty("sensor1R2") public Double sensor1R2;
  public Double sensor2a, sensor2b, sensor2c;
  @JsonProperty("sensor2R2") public Double sensor2R2;
  public Double sensor3a, sensor3b, sensor3c;
  @JsonProperty("sensor3R2") public Double sensor3R2;

  public boolean hasAllCoefficients() {
    return sensor1a != null && sensor1b != null && sensor1c != null
        && sensor2a != null && sensor2b != null && sensor2c != null
        && sensor3a != null && sensor3b != null && sensor3c != null;
  }
}
```

- [ ] **Step 3: Write the result sealed type**

```java
package org.osi.server.chameleon;

public sealed interface ViaFarmResult {
  record Found(ViaFarmResponse response) implements ViaFarmResult {}
  record NotFound() implements ViaFarmResult {}
  record InvalidResponse(String detail) implements ViaFarmResult {}
  record Unavailable(String detail) implements ViaFarmResult {}
}
```

- [ ] **Step 4: Write the failing client test**

```java
package org.osi.server.chameleon;

import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.*;
import org.springframework.web.client.RestTemplate;
import static org.junit.jupiter.api.Assertions.*;

class ViaFarmClientTest {
  MockWebServer server;
  ViaFarmClient client;

  @BeforeEach void setUp() throws Exception {
    server = new MockWebServer();
    server.start();
    client = new ViaFarmClient(new RestTemplate(),
        server.url("/api").toString(), "test-token", 5000);
  }
  @AfterEach void tearDown() throws Exception { server.shutdown(); }

  @Test void returnsFoundOn200() {
    server.enqueue(new MockResponse().setBody(
        "{\"sensor1a\":9.81,\"sensor1b\":0.13,\"sensor1c\":6.4,\"sensor1R2\":0.99," +
        "\"sensor2a\":9.98,\"sensor2b\":0.13,\"sensor2c\":6.63,\"sensor2R2\":0.99," +
        "\"sensor3a\":9.7,\"sensor3b\":0.12,\"sensor3c\":5.79,\"sensor3R2\":0.99," +
        "\"temperature_id_full\":\"28DE7EC80B0000E2\"," +
        "\"test_rig_run_start_date\":\"2024-06-12T12:57:37.286769Z\"}")
        .addHeader("Content-Type", "application/json"));

    var result = client.fetch("28DE7EC80B0000E2");
    assertInstanceOf(ViaFarmResult.Found.class, result);
    assertEquals(9.81, ((ViaFarmResult.Found) result).response().sensor1a);
  }

  @Test void returnsNotFoundOn302() {
    server.enqueue(new MockResponse().setResponseCode(302).addHeader("Location", "/login"));
    assertInstanceOf(ViaFarmResult.NotFound.class, client.fetch("28DE7EC80B0000FF"));
  }

  @Test void returnsInvalidResponseOnMalformedBody() {
    server.enqueue(new MockResponse().setBody("not json").addHeader("Content-Type", "application/json"));
    assertInstanceOf(ViaFarmResult.InvalidResponse.class, client.fetch("28DE7EC80B0000E2"));
  }

  @Test void returnsInvalidResponseWhenCoefficientsMissing() {
    server.enqueue(new MockResponse().setBody("{\"temperature_id_full\":\"X\"}")
        .addHeader("Content-Type", "application/json"));
    assertInstanceOf(ViaFarmResult.InvalidResponse.class, client.fetch("28DE7EC80B0000E2"));
  }

  @Test void returnsUnavailableOn5xx() {
    server.enqueue(new MockResponse().setResponseCode(503));
    assertInstanceOf(ViaFarmResult.Unavailable.class, client.fetch("28DE7EC80B0000E2"));
  }
}
```

- [ ] **Step 5: Run, verify fail**

```bash
./gradlew test --tests org.osi.server.chameleon.ViaFarmClientTest
```

Expected: compile failure (ViaFarmClient missing).

- [ ] **Step 6: Implement the client**

```java
package org.osi.server.chameleon;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.*;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Duration;

@Component
public class ViaFarmClient {
  private final RestTemplate restTemplate;
  private final String baseUrl;
  private final String apiToken;

  public ViaFarmClient(RestTemplate restTemplate, String baseUrl, String apiToken, int timeoutMillis) {
    this.restTemplate = restTemplate;
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
  }

  public ViaFarmClient(RestTemplateBuilder builder,
                       @Value("${via-farm.base-url}") String baseUrl,
                       @Value("${via-farm.api-token}") String apiToken,
                       @Value("${via-farm.timeout-millis:5000}") int timeoutMillis) {
    this(builder
            .setConnectTimeout(Duration.ofMillis(timeoutMillis))
            .setReadTimeout(Duration.ofMillis(timeoutMillis))
            .build(),
         baseUrl, apiToken, timeoutMillis);
  }

  public ViaFarmResult fetch(String arrayId) {
    String url = UriComponentsBuilder.fromHttpUrl(baseUrl)
        .path("/curve_params/")
        .queryParam("temperature_id_full", arrayId)
        .toUriString();

    HttpHeaders headers = new HttpHeaders();
    headers.set("Authorization", "Token " + apiToken);
    HttpEntity<Void> request = new HttpEntity<>(headers);

    try {
      ResponseEntity<ViaFarmResponse> response = restTemplate.exchange(
          url, HttpMethod.GET, request, ViaFarmResponse.class);
      ViaFarmResponse body = response.getBody();
      if (body == null || !body.hasAllCoefficients()) {
        return new ViaFarmResult.InvalidResponse("missing coefficients");
      }
      return new ViaFarmResult.Found(body);
    } catch (HttpClientErrorException e) {
      if (e.getStatusCode() == HttpStatus.FOUND || e.getStatusCode() == HttpStatus.NOT_FOUND) {
        return new ViaFarmResult.NotFound();
      }
      return new ViaFarmResult.Unavailable("client error: " + e.getStatusCode());
    } catch (HttpServerErrorException e) {
      return new ViaFarmResult.Unavailable("server error: " + e.getStatusCode());
    } catch (ResourceAccessException e) {
      return new ViaFarmResult.Unavailable("network error: " + e.getMessage());
    } catch (org.springframework.web.client.RestClientException e) {
      return new ViaFarmResult.InvalidResponse(e.getMessage());
    }
  }
}
```

- [ ] **Step 7: Configure RestTemplate to not follow 302 redirects**

The default RestTemplate follows redirects, which would hide via.farm's 302-for-unknown signal. Add a bean (or update the existing one) in a config class — find the existing `RestTemplate` bean in the codebase; if none, create `backend/src/main/java/org/osi/server/chameleon/ChameleonHttpConfig.java`:

```java
package org.osi.server.chameleon;

import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;

@Configuration
class ChameleonHttpConfig {
  @Bean("viaFarmRestTemplate")
  RestTemplate viaFarmRestTemplate(RestTemplateBuilder builder) {
    return builder
        .requestFactory(() -> {
          SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
          // No automatic redirect follow — 302 signals unknown ID.
          return factory;
        })
        .build();
  }
}
```

Update `ViaFarmClient` to `@Qualifier("viaFarmRestTemplate")` on the builder-based constructor. Note: `SimpleClientHttpRequestFactory` by default DOES follow redirects; explicitly disable via `factory.setOutputStreaming(false)` is not enough — instead use `factory.setBufferRequestBody(false)` and rely on `HttpURLConnection.setInstanceFollowRedirects(false)` per-request. Cleaner option: parse the response status manually. For the simple case here, accept the redirect-followed behavior and treat the redirect target as `InvalidResponse` (the test for 302 still passes because the redirect target won't parse as a valid response). Re-verify the test expectations after running.

- [ ] **Step 8: Run, verify pass**

```bash
./gradlew test --tests org.osi.server.chameleon.ViaFarmClientTest
```

Expected: 5 tests pass. If `returnsNotFoundOn302` fails because RestTemplate followed the redirect to `/login` (which 404s in MockWebServer), update the test to enqueue a second response (404) for the redirect target — assert NotFound based on the final 4xx. Alternative: assert InvalidResponse and update production logic accordingly. Either is acceptable; pick the behavior that matches what `via.farm` actually serves at the redirect target (verify with a real curl during this step against an unknown ID and `-L`).

- [ ] **Step 9: Add okhttp mockwebserver test dependency if missing**

```bash
grep -q "mockwebserver" backend/build.gradle && echo "ok" || echo "ADD: testImplementation 'com.squareup.okhttp3:mockwebserver:4.12.0'"
```

If "ADD" shown: add the line to `backend/build.gradle` `dependencies { ... }` block.

- [ ] **Step 10: Commit**

```bash
git add backend/src/main/java/org/osi/server/chameleon/ViaFarm*.java \
        backend/src/main/java/org/osi/server/chameleon/ChameleonHttpConfig.java \
        backend/src/test/java/org/osi/server/chameleon/ViaFarmClientTest.java \
        backend/src/main/resources/application.yml \
        backend/build.gradle
git commit -m "feat(chameleon): add ViaFarmClient with response parsing + 302/5xx handling"
```

---

### Task A6: ChameleonCalibrationsService — cache-aside + negative cache

**Files:**
- Create: `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsService.java`
- Test: `backend/src/test/java/org/osi/server/chameleon/ChameleonCalibrationsServiceTest.java`

- [ ] **Step 1: Write the failing test**

```java
package org.osi.server.chameleon;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@SpringBootTest
@Transactional
class ChameleonCalibrationsServiceTest {
  @Autowired ChameleonCalibrationsService service;
  @Autowired ChameleonCalibrationRepository repo;
  @Autowired ChameleonCalibrationMissRepository missRepo;
  @MockBean ViaFarmClient viaFarmClient;

  static final String ARRAY_ID = "28F8B2B40F0000C1";

  @BeforeEach void wipe() { repo.deleteAll(); missRepo.deleteAll(); }

  @Test void cacheHit_returnsRowWithoutCallingViaFarm() {
    var seeded = new ChameleonCalibration();
    seeded.setArrayId(ARRAY_ID); seeded.setSensorId("F8C1");
    seeded.setSensor1A(1); seeded.setSensor1B(2); seeded.setSensor1C(3);
    seeded.setSensor2A(1); seeded.setSensor2B(2); seeded.setSensor2C(3);
    seeded.setSensor3A(1); seeded.setSensor3B(2); seeded.setSensor3C(3);
    seeded.setSource("via_api"); seeded.setFetchedAt(OffsetDateTime.now());
    repo.save(seeded);

    Optional<ChameleonCalibration> found = service.lookup(ARRAY_ID);
    assertTrue(found.isPresent());
    verifyNoInteractions(viaFarmClient);
  }

  @Test void cacheMiss_callsViaFarm_persistsResult() {
    var response = new ViaFarmResponse();
    response.temperatureIdFull = ARRAY_ID;
    response.sensor1a=9.81; response.sensor1b=0.13; response.sensor1c=6.4;
    response.sensor2a=9.98; response.sensor2b=0.13; response.sensor2c=6.63;
    response.sensor3a=9.7;  response.sensor3b=0.12; response.sensor3c=5.79;
    when(viaFarmClient.fetch(ARRAY_ID)).thenReturn(new ViaFarmResult.Found(response));

    var result = service.lookup(ARRAY_ID);
    assertTrue(result.isPresent());
    assertEquals(9.81, result.get().getSensor1A());
    assertTrue(repo.findByArrayId(ARRAY_ID).isPresent());
  }

  @Test void cacheMiss_viaFarmNotFound_writesMissRow_returnsEmpty() {
    when(viaFarmClient.fetch(ARRAY_ID)).thenReturn(new ViaFarmResult.NotFound());

    assertTrue(service.lookup(ARRAY_ID).isEmpty());
    assertTrue(missRepo.findById(ARRAY_ID).isPresent());
  }

  @Test void freshMissRow_skipsViaFarm() {
    var miss = new ChameleonCalibrationMiss();
    miss.setArrayId(ARRAY_ID); miss.setLastTried(OffsetDateTime.now()); miss.setReason("not_found");
    missRepo.save(miss);

    assertTrue(service.lookup(ARRAY_ID).isEmpty());
    verifyNoInteractions(viaFarmClient);
  }

  @Test void expiredMissRow_retriesViaFarm() {
    var miss = new ChameleonCalibrationMiss();
    miss.setArrayId(ARRAY_ID);
    miss.setLastTried(OffsetDateTime.now().minusHours(25));
    miss.setReason("not_found");
    missRepo.save(miss);
    when(viaFarmClient.fetch(ARRAY_ID)).thenReturn(new ViaFarmResult.NotFound());

    service.lookup(ARRAY_ID);
    verify(viaFarmClient).fetch(ARRAY_ID);
  }

  @Test void viaFarmUnavailable_returnsUpstreamUnavailable_doesNotWriteMissRow() {
    when(viaFarmClient.fetch(ARRAY_ID))
        .thenReturn(new ViaFarmResult.Unavailable("net"));

    var result = service.lookup(ARRAY_ID);
    assertTrue(result.isEmpty());
    assertFalse(missRepo.findById(ARRAY_ID).isPresent());
  }

  @Test void normalizesInputToUppercase() {
    when(viaFarmClient.fetch("28F8B2B40F0000C1"))
        .thenReturn(new ViaFarmResult.NotFound());
    service.lookup("28f8b2b40f0000c1");
    verify(viaFarmClient).fetch("28F8B2B40F0000C1");
  }
}
```

- [ ] **Step 2: Run, verify fail**

```bash
./gradlew test --tests org.osi.server.chameleon.ChameleonCalibrationsServiceTest
```

Expected: compile failure (Service missing).

- [ ] **Step 3: Implement service**

```java
package org.osi.server.chameleon;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Optional;

@Service
public class ChameleonCalibrationsService {
  private static final Logger log = LoggerFactory.getLogger(ChameleonCalibrationsService.class);
  static final int MISS_TTL_HOURS = 24;

  private final ChameleonCalibrationRepository calibRepo;
  private final ChameleonCalibrationMissRepository missRepo;
  private final ViaFarmClient viaFarm;

  public ChameleonCalibrationsService(ChameleonCalibrationRepository calibRepo,
                                      ChameleonCalibrationMissRepository missRepo,
                                      ViaFarmClient viaFarm) {
    this.calibRepo = calibRepo;
    this.missRepo = missRepo;
    this.viaFarm = viaFarm;
  }

  /** Returns the cached or freshly-fetched calibration. Empty if via.farm doesn't have it. */
  @Transactional
  public Optional<ChameleonCalibration> lookup(String inputArrayId) {
    String arrayId = SensorIdDerivation.normalize(inputArrayId);

    Optional<ChameleonCalibration> cached = calibRepo.findByArrayId(arrayId);
    if (cached.isPresent()) return cached;

    OffsetDateTime cutoff = OffsetDateTime.now().minusHours(MISS_TTL_HOURS);
    if (missRepo.findByArrayIdAndLastTriedAfter(arrayId, cutoff).isPresent()) {
      return Optional.empty();
    }

    ViaFarmResult result = viaFarm.fetch(arrayId);
    return switch (result) {
      case ViaFarmResult.Found(ViaFarmResponse r) -> Optional.of(persist(arrayId, r, "via_api"));
      case ViaFarmResult.NotFound() -> { writeMiss(arrayId, "not_found"); yield Optional.empty(); }
      case ViaFarmResult.InvalidResponse(String d) -> { writeMiss(arrayId, "invalid_response"); yield Optional.empty(); }
      case ViaFarmResult.Unavailable(String d) -> Optional.empty();
    };
  }

  /** Admin path: force re-fetch, ignoring miss cache. */
  @Transactional
  public Optional<ChameleonCalibration> forceRefresh(String inputArrayId) {
    String arrayId = SensorIdDerivation.normalize(inputArrayId);
    ViaFarmResult result = viaFarm.fetch(arrayId);
    return switch (result) {
      case ViaFarmResult.Found(ViaFarmResponse r) -> Optional.of(persist(arrayId, r, "via_api"));
      case ViaFarmResult.NotFound() -> { writeMiss(arrayId, "not_found"); yield Optional.empty(); }
      case ViaFarmResult.InvalidResponse(String d) -> { writeMiss(arrayId, "invalid_response"); yield Optional.empty(); }
      case ViaFarmResult.Unavailable(String d) -> Optional.empty();
    };
  }

  private ChameleonCalibration persist(String arrayId, ViaFarmResponse r, String source) {
    ChameleonCalibration row = calibRepo.findByArrayId(arrayId).orElseGet(ChameleonCalibration::new);
    row.setArrayId(arrayId);
    row.setSensorId(SensorIdDerivation.deriveSensorId(arrayId));
    row.setSensor1A(r.sensor1a); row.setSensor1B(r.sensor1b); row.setSensor1C(r.sensor1c); row.setSensor1R2(r.sensor1R2);
    row.setSensor2A(r.sensor2a); row.setSensor2B(r.sensor2b); row.setSensor2C(r.sensor2c); row.setSensor2R2(r.sensor2R2);
    row.setSensor3A(r.sensor3a); row.setSensor3B(r.sensor3b); row.setSensor3C(r.sensor3c); row.setSensor3R2(r.sensor3R2);
    row.setTestRigRunStartDate(parseDateOrNull(r.testRigRunStartDate));
    row.setSource(source);
    row.setFetchedAt(OffsetDateTime.now());
    missRepo.deleteById(arrayId);  // Promote from miss → hit.
    return calibRepo.save(row);
  }

  private void writeMiss(String arrayId, String reason) {
    ChameleonCalibrationMiss row = missRepo.findById(arrayId).orElseGet(ChameleonCalibrationMiss::new);
    row.setArrayId(arrayId);
    row.setLastTried(OffsetDateTime.now());
    row.setReason(reason);
    missRepo.save(row);
  }

  private OffsetDateTime parseDateOrNull(String iso) {
    if (iso == null) return null;
    try { return OffsetDateTime.parse(iso); }
    catch (DateTimeParseException e) {
      log.warn("Bad test_rig_run_start_date {}, dropping field", iso);
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
./gradlew test --tests org.osi.server.chameleon.ChameleonCalibrationsServiceTest
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsService.java \
        backend/src/test/java/org/osi/server/chameleon/ChameleonCalibrationsServiceTest.java
git commit -m "feat(chameleon): add ChameleonCalibrationsService with cache-aside + negative cache"
```

---

### Task A7: Edge REST endpoints (lookup + batch)

**Files:**
- Create: `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsController.java`
- Create: `backend/src/main/java/org/osi/server/chameleon/CalibrationDto.java`
- Test: `backend/src/test/java/org/osi/server/chameleon/ChameleonCalibrationsControllerTest.java`

- [ ] **Step 1: Write the DTO**

```java
package org.osi.server.chameleon;

public record CalibrationDto(
    String array_id, String sensor_id,
    double sensor1_a, double sensor1_b, double sensor1_c, Double sensor1_r2,
    double sensor2_a, double sensor2_b, double sensor2_c, Double sensor2_r2,
    double sensor3_a, double sensor3_b, double sensor3_c, Double sensor3_r2,
    String test_rig_run_start_date,
    String source
) {
  static CalibrationDto from(ChameleonCalibration c) {
    return new CalibrationDto(
        c.getArrayId(), c.getSensorId(),
        c.getSensor1A(), c.getSensor1B(), c.getSensor1C(), c.getSensor1R2(),
        c.getSensor2A(), c.getSensor2B(), c.getSensor2C(), c.getSensor2R2(),
        c.getSensor3A(), c.getSensor3B(), c.getSensor3C(), c.getSensor3R2(),
        c.getTestRigRunStartDate() == null ? null : c.getTestRigRunStartDate().toString(),
        c.getSource()
    );
  }
}
```

- [ ] **Step 2: Write the failing controller test**

```java
package org.osi.server.chameleon;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ChameleonCalibrationsControllerTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper om;
  @MockBean ChameleonCalibrationsService service;

  @Test void singleLookupReturnsCalibration() throws Exception {
    var c = new ChameleonCalibration();
    c.setArrayId("28F8B2B40F0000C1"); c.setSensorId("F8C1");
    c.setSensor1A(1); c.setSensor1B(2); c.setSensor1C(3);
    c.setSensor2A(1); c.setSensor2B(2); c.setSensor2C(3);
    c.setSensor3A(1); c.setSensor3B(2); c.setSensor3C(3);
    c.setSource("via_api");
    when(service.lookup(eq("28F8B2B40F0000C1"))).thenReturn(Optional.of(c));

    mvc.perform(get("/api/v1/sync/chameleon/calibrations/28F8B2B40F0000C1"))
       .andExpect(status().isOk())
       .andExpect(jsonPath("$.array_id").value("28F8B2B40F0000C1"))
       .andExpect(jsonPath("$.sensor_id").value("F8C1"));
  }

  @Test void singleLookup404OnEmpty() throws Exception {
    when(service.lookup(eq("28F8B2B40F0000FF"))).thenReturn(Optional.empty());
    mvc.perform(get("/api/v1/sync/chameleon/calibrations/28F8B2B40F0000FF"))
       .andExpect(status().isNotFound());
  }

  @Test void batchSplitsFoundAndNotFound() throws Exception {
    when(service.lookup("28F8B2B40F0000C1")).thenReturn(Optional.of(stubCalibration("28F8B2B40F0000C1")));
    when(service.lookup("28F8B2B40F0000FF")).thenReturn(Optional.empty());
    String body = om.writeValueAsString(Map.of("array_ids",
        java.util.List.of("28F8B2B40F0000C1", "28F8B2B40F0000FF")));

    mvc.perform(post("/api/v1/sync/chameleon/calibrations/lookup")
            .contentType("application/json").content(body))
       .andExpect(status().isOk())
       .andExpect(jsonPath("$.calibrations.length()").value(1))
       .andExpect(jsonPath("$.not_found.length()").value(1))
       .andExpect(jsonPath("$.not_found[0]").value("28F8B2B40F0000FF"));
  }

  private ChameleonCalibration stubCalibration(String id) {
    var c = new ChameleonCalibration();
    c.setArrayId(id); c.setSensorId("F8C1");
    c.setSensor1A(1); c.setSensor1B(2); c.setSensor1C(3);
    c.setSensor2A(1); c.setSensor2B(2); c.setSensor2C(3);
    c.setSensor3A(1); c.setSensor3B(2); c.setSensor3C(3);
    c.setSource("via_api");
    return c;
  }
}
```

- [ ] **Step 3: Implement the controller**

```java
package org.osi.server.chameleon;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/sync/chameleon/calibrations")
public class ChameleonCalibrationsController {
  private final ChameleonCalibrationsService service;

  public ChameleonCalibrationsController(ChameleonCalibrationsService service) {
    this.service = service;
  }

  @GetMapping("/{arrayId}")
  public ResponseEntity<?> lookup(@PathVariable String arrayId) {
    return service.lookup(arrayId)
        .map(c -> ResponseEntity.ok((Object) CalibrationDto.from(c)))
        .orElse(ResponseEntity.status(404).body(Map.of("error", "not_found")));
  }

  @PostMapping("/lookup")
  public BatchResponse batchLookup(@RequestBody BatchRequest req) {
    List<CalibrationDto> calibrations = new ArrayList<>();
    List<String> notFound = new ArrayList<>();
    for (String arrayId : req.array_ids()) {
      service.lookup(arrayId).ifPresentOrElse(
          c -> calibrations.add(CalibrationDto.from(c)),
          () -> notFound.add(SensorIdDerivation.normalize(arrayId))
      );
    }
    return new BatchResponse(calibrations, notFound, List.of());
  }

  public record BatchRequest(List<String> array_ids) {}
  public record BatchResponse(List<CalibrationDto> calibrations,
                              List<String> not_found,
                              List<String> errors) {}
}
```

- [ ] **Step 4: Run tests**

```bash
./gradlew test --tests org.osi.server.chameleon.ChameleonCalibrationsControllerTest
```

Expected: 3 tests pass.

- [ ] **Step 5: Verify sync auth applies**

```bash
grep -rn "/api/v1/sync" backend/src/main/java/org/osi/server/security/ | head
```

If the security config matches `/api/v1/sync/**` already, this controller is auto-protected. If it only protects narrower paths, extend the matcher to cover `/api/v1/sync/chameleon/**` (one-line change in the security config — touch only that file in this commit).

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/chameleon/CalibrationDto.java \
        backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsController.java \
        backend/src/test/java/org/osi/server/chameleon/ChameleonCalibrationsControllerTest.java
git commit -m "feat(chameleon): edge sync endpoints for calibration lookup + batch"
```

---

### Task A8: Admin REST endpoints (refresh + dump)

**Files:**
- Create: `backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsAdminController.java`
- Test: `backend/src/test/java/org/osi/server/chameleon/ChameleonCalibrationsAdminControllerTest.java`

- [ ] **Step 1: Write the failing test**

```java
package org.osi.server.chameleon;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Optional;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ChameleonCalibrationsAdminControllerTest {
  @Autowired MockMvc mvc;
  @MockBean ChameleonCalibrationsService service;
  @MockBean ChameleonCalibrationRepository repo;

  @Test void refreshForcesReFetch() throws Exception {
    var c = new ChameleonCalibration();
    c.setArrayId("28F8B2B40F0000C1"); c.setSensorId("F8C1");
    c.setSensor1A(1); c.setSensor1B(2); c.setSensor1C(3);
    c.setSensor2A(1); c.setSensor2B(2); c.setSensor2C(3);
    c.setSensor3A(1); c.setSensor3B(2); c.setSensor3C(3);
    c.setSource("via_api");
    when(service.forceRefresh("28F8B2B40F0000C1")).thenReturn(Optional.of(c));

    mvc.perform(post("/api/v1/admin/chameleon/calibrations/28F8B2B40F0000C1/refresh"))
       .andExpect(status().isOk())
       .andExpect(jsonPath("$.array_id").value("28F8B2B40F0000C1"));
  }

  @Test void dumpReturnsAllRows() throws Exception {
    when(repo.findAll()).thenReturn(List.of());
    mvc.perform(get("/api/v1/admin/chameleon/calibrations"))
       .andExpect(status().isOk())
       .andExpect(jsonPath("$.length()").value(0));
  }
}
```

- [ ] **Step 2: Implement**

```java
package org.osi.server.chameleon;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/admin/chameleon/calibrations")
public class ChameleonCalibrationsAdminController {
  private final ChameleonCalibrationsService service;
  private final ChameleonCalibrationRepository repo;

  public ChameleonCalibrationsAdminController(ChameleonCalibrationsService service,
                                              ChameleonCalibrationRepository repo) {
    this.service = service;
    this.repo = repo;
  }

  @PostMapping("/{arrayId}/refresh")
  public ResponseEntity<?> refresh(@PathVariable String arrayId) {
    return service.forceRefresh(arrayId)
        .map(c -> ResponseEntity.ok((Object) CalibrationDto.from(c)))
        .orElse(ResponseEntity.status(404).body(Map.of("error", "not_found")));
  }

  @GetMapping
  public List<CalibrationDto> dump() {
    return repo.findAll().stream().map(CalibrationDto::from).toList();
  }
}
```

- [ ] **Step 3: Verify admin path is protected**

```bash
grep -rn "/api/v1/admin" backend/src/main/java/org/osi/server/security/ | head
```

If admin paths aren't already protected by the security config, extend the matcher to require admin auth on `/api/v1/admin/**` (one-line change in the security config). If admin auth doesn't yet exist as a concept, defer this protection to a follow-up — the endpoint stays inert in production until the security config catches up. Note in the spec's "open questions" if so.

- [ ] **Step 4: Run tests**

```bash
./gradlew test --tests org.osi.server.chameleon.ChameleonCalibrationsAdminControllerTest
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsAdminController.java \
        backend/src/test/java/org/osi/server/chameleon/ChameleonCalibrationsAdminControllerTest.java
git commit -m "feat(chameleon): admin refresh + dump endpoints"
```

---

### Task A9: ChameleonRecomputeService — cloud-side backfill

**Files:**
- Create: `backend/src/main/java/org/osi/server/chameleon/ChameleonRecomputeService.java`
- Create: `backend/src/main/java/org/osi/server/chameleon/KpaCurve.java`
- Test: `backend/src/test/java/org/osi/server/chameleon/KpaCurveTest.java`
- Test: `backend/src/test/java/org/osi/server/chameleon/ChameleonRecomputeServiceTest.java`

- [ ] **Step 1: Write the failing KpaCurve test**

```java
package org.osi.server.chameleon;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class KpaCurveTest {
  @Test void computesFromFormula() {
    Double k = KpaCurve.compute(10000.0, 9.81, 0.13, 6.4);
    assertNotNull(k);
    double expected = 9.81 * Math.log(10.0) + 0.13 * 10.0 + 6.4;
    expected = Math.min(300, Math.max(0, expected));
    assertEquals(Math.round(expected * 100) / 100.0, k, 0.001);
  }
  @Test void returnsNullOnZeroOhms() { assertNull(KpaCurve.compute(0.0, 1, 1, 1)); }
  @Test void returnsNullOnNegativeOhms() { assertNull(KpaCurve.compute(-1.0, 1, 1, 1)); }
  @Test void returnsNullOnAboveCap() { assertNull(KpaCurve.compute(10_000_000.0, 1, 1, 1)); }
}
```

- [ ] **Step 2: Implement KpaCurve**

```java
package org.osi.server.chameleon;

public final class KpaCurve {
  private static final double MAX_VALID_OHMS = 10_000_000;
  private static final double MIN_KPA = 0;
  private static final double MAX_KPA = 300;

  private KpaCurve() {}

  public static Double compute(Double ohms, double a, double b, double c) {
    if (ohms == null || ohms <= 0 || ohms >= MAX_VALID_OHMS) return null;
    double rk = ohms / 1000.0;
    double kpa = a * Math.log(rk) + b * rk + c;
    if (!Double.isFinite(kpa)) return null;
    double clamped = Math.min(MAX_KPA, Math.max(MIN_KPA, kpa));
    return Math.round(clamped * 100) / 100.0;
  }
}
```

- [ ] **Step 3: Run KpaCurve test**

```bash
./gradlew test --tests org.osi.server.chameleon.KpaCurveTest
```

Expected: 4 tests pass.

- [ ] **Step 4: Inspect schema of `chameleon_readings`**

```bash
psql "$DATABASE_URL" -c "\d chameleon_readings" | grep -E "swt_|r._ohm|array_id"
```

The cloud stores computed kPa directly on `chameleon_readings.swt_{1,2,3}` (V40 `chameleon_full_mirror`); there is no `device_data` table on the cloud. Confirm exact field names before writing the SQL.

- [ ] **Step 5: Write the failing recompute test**

```java
package org.osi.server.chameleon;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
@Transactional
class ChameleonRecomputeServiceTest {
  @Autowired ChameleonRecomputeService recompute;
  @Autowired ChameleonCalibrationRepository calibRepo;
  @Autowired JdbcTemplate jdbc;

  @Test void backfillsNullSwtAfterCalibrationArrives() {
    // Seed: a device + a chameleon_readings row with raw resistances and NULL swt_*.
    Long deviceId = jdbc.queryForObject(
        "INSERT INTO devices(deveui, type_id) VALUES('0000000000000001','DRAGINO_LSN50') RETURNING id",
        Long.class);
    OffsetDateTime ts = OffsetDateTime.now();
    Long readingId = jdbc.queryForObject(
        "INSERT INTO chameleon_readings(device_id, recorded_at, array_id, " +
        "r1_ohm_comp, r2_ohm_comp, r3_ohm_comp, swt_1, swt_2, swt_3) " +
        "VALUES(?,?,?,?,?,?,NULL,NULL,NULL) RETURNING id",
        Long.class, deviceId, ts, "28F8B2B40F0000C1", 10000.0, 20000.0, 30000.0);

    var cal = new ChameleonCalibration();
    cal.setArrayId("28F8B2B40F0000C1"); cal.setSensorId("F8C1");
    cal.setSensor1A(9.81); cal.setSensor1B(0.13); cal.setSensor1C(6.4);
    cal.setSensor2A(9.98); cal.setSensor2B(0.13); cal.setSensor2C(6.63);
    cal.setSensor3A(9.7);  cal.setSensor3B(0.12); cal.setSensor3C(5.79);
    cal.setSource("via_api"); cal.setFetchedAt(OffsetDateTime.now());
    calibRepo.save(cal);

    recompute.recomputeForArrayId("28F8B2B40F0000C1");

    Double swt1 = jdbc.queryForObject(
        "SELECT swt_1 FROM chameleon_readings WHERE id = ?", Double.class, readingId);
    assertNotNull(swt1);
    assertTrue(swt1 > 0 && swt1 <= 300);
  }
}
```

- [ ] **Step 6: Implement the recompute service**

```java
package org.osi.server.chameleon;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

@Service
public class ChameleonRecomputeService {
  private final JdbcTemplate jdbc;
  private final ChameleonCalibrationRepository calibRepo;

  public ChameleonRecomputeService(JdbcTemplate jdbc, ChameleonCalibrationRepository calibRepo) {
    this.jdbc = jdbc;
    this.calibRepo = calibRepo;
  }

  @Transactional
  public int recomputeForArrayId(String arrayId) {
    var calib = calibRepo.findByArrayId(arrayId).orElse(null);
    if (calib == null) return 0;
    List<Map<String, Object>> rows = jdbc.queryForList(
        "SELECT id, r1_ohm_comp, r2_ohm_comp, r3_ohm_comp " +
        "FROM chameleon_readings " +
        "WHERE array_id = ? AND swt_1 IS NULL AND swt_2 IS NULL AND swt_3 IS NULL",
        arrayId);
    int updated = 0;
    for (var row : rows) {
      Double k1 = KpaCurve.compute(toDouble(row.get("r1_ohm_comp")),
          calib.getSensor1A(), calib.getSensor1B(), calib.getSensor1C());
      Double k2 = KpaCurve.compute(toDouble(row.get("r2_ohm_comp")),
          calib.getSensor2A(), calib.getSensor2B(), calib.getSensor2C());
      Double k3 = KpaCurve.compute(toDouble(row.get("r3_ohm_comp")),
          calib.getSensor3A(), calib.getSensor3B(), calib.getSensor3C());
      updated += jdbc.update(
          "UPDATE chameleon_readings SET swt_1 = ?, swt_2 = ?, swt_3 = ? WHERE id = ?",
          k1, k2, k3, row.get("id"));
    }
    return updated;
  }

  private static Double toDouble(Object v) {
    return v == null ? null : ((Number) v).doubleValue();
  }
}
```

- [ ] **Step 7: Hook recompute into service write path**

In `ChameleonCalibrationsService.persist(...)`, after `calibRepo.save(row)`, call `recompute.recomputeForArrayId(arrayId)`. Inject `ChameleonRecomputeService` via constructor. This makes lazy-fetch arrivals trigger backfill server-side.

Also subscribe to inbox `chameleon_readings` arrivals: in whatever class handles `chameleon_readings` upserts on the sync inbox path (find via `grep -rn "chameleon_readings" backend/src/main/java/`), after inserting a row, call `recompute.recomputeForArrayId(reading.arrayId)` — bounded recompute touches only rows for that array_id with NULL swt_*.

- [ ] **Step 8: Run tests**

```bash
./gradlew test --tests org.osi.server.chameleon.ChameleonRecomputeServiceTest \
                   --tests org.osi.server.chameleon.ChameleonCalibrationsServiceTest
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add backend/src/main/java/org/osi/server/chameleon/KpaCurve.java \
        backend/src/main/java/org/osi/server/chameleon/ChameleonRecomputeService.java \
        backend/src/main/java/org/osi/server/chameleon/ChameleonCalibrationsService.java \
        backend/src/test/java/org/osi/server/chameleon/KpaCurveTest.java \
        backend/src/test/java/org/osi/server/chameleon/ChameleonRecomputeServiceTest.java \
        $(grep -rl "chameleon_readings" backend/src/main/java/ | xargs)
git commit -m "feat(chameleon): cloud-side recompute on calibration arrival + readings ingest"
```

---

### Task A10: Retire per-device calibration plumbing (PUT endpoint, ChameleonConfig)

**Files:**
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java`
- Modify: `backend/src/main/java/org/osi/server/device/DeviceService.java`

- [ ] **Step 1: Locate the endpoint and the nested types**

```bash
grep -n "chameleon-config\|ChameleonConfigRequest\|ChameleonConfig" backend/src/main/java/org/osi/server/device/DeviceController.java backend/src/main/java/org/osi/server/device/DeviceService.java
```

Note the line ranges.

- [ ] **Step 2: Delete the PUT endpoint method in DeviceController**

Remove the entire `@PutMapping("/{deveui}/chameleon-config")` method and the inner `ChameleonConfigRequest` record. If imports become unused, remove them.

- [ ] **Step 3: Delete the corresponding service method + ChameleonConfig type in DeviceService**

Remove the method that accepts a `ChameleonConfig` argument and persists the (now-dropped) columns. Remove the `ChameleonConfig` inner type. Remove any DTO fields on `Device` entity / DTOs that reference `chameleonSwt[123][ABC]`.

- [ ] **Step 4: Verify Device entity has no orphan fields**

```bash
grep -n "chameleonSwt[123][ABC]\|chameleon_swt[123]_[abc]" backend/src/main/java/org/osi/server/device/
```

Expected: empty. (Depth fields `chameleonSwt[123]DepthCm` stay.)

- [ ] **Step 5: Compile + run device tests**

```bash
./gradlew compileJava && ./gradlew test --tests "org.osi.server.device.*"
```

Expected: BUILD SUCCESSFUL, device tests pass. If any tests referenced the removed types, update them — these tests are testing the old contract that no longer exists, so either delete them (if the test was specifically for `chameleon-config`) or remove the chameleon-coefficient assertions (if the test covered broader device behavior).

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/device/DeviceController.java \
        backend/src/main/java/org/osi/server/device/DeviceService.java \
        $(grep -rl "chameleonSwt[123][ABC]\|ChameleonConfig" backend/src/ | xargs)
git commit -m "refactor(chameleon): retire PUT /chameleon-config and ChameleonConfig DTO"
```

---

### Task A11: Integration test — end-to-end edge endpoint exercising via.farm

**Files:**
- Test: `backend/src/test/java/org/osi/server/chameleon/ChameleonCalibrationsIntegrationTest.java`

- [ ] **Step 1: Write the test**

```java
package org.osi.server.chameleon;

import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ChameleonCalibrationsIntegrationTest {
  static MockWebServer mock;

  @DynamicPropertySource
  static void register(DynamicPropertyRegistry r) throws Exception {
    mock = new MockWebServer(); mock.start();
    r.add("via-farm.base-url", () -> mock.url("/api").toString());
    r.add("via-farm.api-token", () -> "test-token");
  }

  @AfterAll static void stop() throws Exception { mock.shutdown(); }

  @Autowired MockMvc mvc;
  @Autowired ChameleonCalibrationRepository repo;

  @BeforeEach void clean() { repo.deleteAll(); }

  @Test void lookupTriggersViaFarmFetchOnFirstCall() throws Exception {
    mock.enqueue(new MockResponse().setBody(
        "{\"sensor1a\":9.81,\"sensor1b\":0.13,\"sensor1c\":6.4," +
        "\"sensor2a\":9.98,\"sensor2b\":0.13,\"sensor2c\":6.63," +
        "\"sensor3a\":9.7,\"sensor3b\":0.12,\"sensor3c\":5.79," +
        "\"temperature_id_full\":\"28F8B2B40F0000C1\"}")
        .addHeader("Content-Type", "application/json"));

    mvc.perform(get("/api/v1/sync/chameleon/calibrations/28F8B2B40F0000C1"))
       .andExpect(status().isOk())
       .andExpect(jsonPath("$.sensor_id").value("F8C1"));

    Assertions.assertEquals(1, mock.getRequestCount());
    Assertions.assertTrue(repo.findByArrayId("28F8B2B40F0000C1").isPresent());
  }
}
```

- [ ] **Step 2: Run**

```bash
./gradlew test --tests org.osi.server.chameleon.ChameleonCalibrationsIntegrationTest
```

Expected: pass.

- [ ] **Step 3: Run the full Phase A test suite**

```bash
./gradlew test --tests "org.osi.server.chameleon.*"
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add backend/src/test/java/org/osi/server/chameleon/ChameleonCalibrationsIntegrationTest.java
git commit -m "test(chameleon): integration coverage for lookup → via.farm → cache"
```

---

### Task A12: Update AGENTS.md (osi-server)

**Files:**
- Modify: `/home/phil/Repos/osi-server/AGENTS.md`

- [ ] **Step 1: Add a section documenting the new endpoints and table**

Append (or insert in the relevant existing section) a brief paragraph describing:
- New table `chameleon_calibrations` (and `chameleon_calibration_misses`)
- New endpoints: `GET /api/v1/sync/chameleon/calibrations/{array_id}`, `POST /api/v1/sync/chameleon/calibrations/lookup`, admin refresh + dump
- Env vars: `VIA_FARM_API_TOKEN`, `VIA_FARM_BASE_URL` (default `https://via.farm/api`)
- Removed: `PUT /api/devices/{deveui}/chameleon-config` and the 9 per-device calibration columns

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document chameleon global calibration table and endpoints"
```

---

# PHASE B — osi-os (SQLite + Node-RED + React)

Work in `/home/phil/Repos/osi-os` for all Phase B tasks.

---

### Task B0: Pre-flight on edge SQLite + flows

**Files:** none

- [ ] **Step 1: Verify OpenWrt-bundled SQLite supports DROP COLUMN**

```bash
ssh root@100.81.220.8 "sqlite3 --version" 2>/dev/null || echo "Pi not reachable; check manually"
```

SQLite ≥ 3.35 supports `ALTER TABLE … DROP COLUMN`. If the live Pi reports < 3.35, the migration in Task B1 must use the "create new, copy, drop, rename" pattern. Local SQLite is 3.53 so unit tests should pass either way. Document the version observed in the commit message for Task B1.

- [ ] **Step 2: Confirm V40+V41 columns exist locally**

```bash
sqlite3 conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  "SELECT name FROM pragma_table_info('devices') WHERE name LIKE 'chameleon_swt%';"
```

Expected: 9 lines (`chameleon_swt[123]_[abc]`) plus the 3 depth columns.

- [ ] **Step 3: Confirm test scripts present**

```bash
ls scripts/verify-lsn50-chameleon-persistence.js scripts/verify-sync-flow.js
```

Expected: both exist.

---

### Task B1: SQLite migration — new tables, drop columns, NULL stale device_data

**Files:**
- Create: `database/migrations/2026-05-19-add-chameleon-calibrations.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Chameleon calibration global table + retire per-device coefficients

CREATE TABLE IF NOT EXISTS chameleon_calibrations (
  array_id                TEXT PRIMARY KEY,
  sensor_id               TEXT NOT NULL,
  sensor1_a               REAL NOT NULL,
  sensor1_b               REAL NOT NULL,
  sensor1_c               REAL NOT NULL,
  sensor1_r2              REAL,
  sensor2_a               REAL NOT NULL,
  sensor2_b               REAL NOT NULL,
  sensor2_c               REAL NOT NULL,
  sensor2_r2              REAL,
  sensor3_a               REAL NOT NULL,
  sensor3_b               REAL NOT NULL,
  sensor3_c               REAL NOT NULL,
  sensor3_r2              REAL,
  test_rig_run_start_date TEXT,
  source                  TEXT NOT NULL,
  fetched_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chameleon_calibrations_sensor_id
  ON chameleon_calibrations(sensor_id);

CREATE TABLE IF NOT EXISTS chameleon_calibration_misses (
  array_id   TEXT PRIMARY KEY,
  last_tried TEXT NOT NULL,
  reason     TEXT
);

ALTER TABLE chameleon_readings ADD COLUMN calibration_status TEXT;

-- Drop the 9 per-device coefficient columns. SQLite >= 3.35 supports DROP COLUMN.
ALTER TABLE devices DROP COLUMN chameleon_swt1_a;
ALTER TABLE devices DROP COLUMN chameleon_swt1_b;
ALTER TABLE devices DROP COLUMN chameleon_swt1_c;
ALTER TABLE devices DROP COLUMN chameleon_swt2_a;
ALTER TABLE devices DROP COLUMN chameleon_swt2_b;
ALTER TABLE devices DROP COLUMN chameleon_swt2_c;
ALTER TABLE devices DROP COLUMN chameleon_swt3_a;
ALTER TABLE devices DROP COLUMN chameleon_swt3_b;
ALTER TABLE devices DROP COLUMN chameleon_swt3_c;

-- NULL kPa for rows joined to chameleon readings; cloud and edge will recompute from calibration.
UPDATE device_data
   SET swt_1 = NULL, swt_2 = NULL, swt_3 = NULL
 WHERE EXISTS (
   SELECT 1 FROM chameleon_readings cr
    WHERE cr.deveui = device_data.deveui
      AND cr.recorded_at = device_data.recorded_at
 );
```

- [ ] **Step 2: Apply locally to a copy of the seed DB and verify**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db /tmp/test.db
sqlite3 /tmp/test.db < database/migrations/2026-05-19-add-chameleon-calibrations.sql
sqlite3 /tmp/test.db ".schema chameleon_calibrations" ".schema chameleon_calibration_misses"
sqlite3 /tmp/test.db "SELECT name FROM pragma_table_info('devices') WHERE name LIKE 'chameleon_swt%';"
```

Expected: tables present, exactly 3 depth columns remain on devices, coefficient columns are gone.

- [ ] **Step 3: Update `database/seed-blank.sql`**

Edit `database/seed-blank.sql`: remove the 9 `chameleon_swt[123]_[abc]` column definitions from the `CREATE TABLE devices`, add the `chameleon_calibrations`, `chameleon_calibration_misses` table definitions, and add `calibration_status` to `chameleon_readings`. Keep schema and migration in sync so a from-scratch seed produces the same structure as a migrated DB.

- [ ] **Step 4: Apply to canonical seed DBs**

```bash
sqlite3 conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  < database/migrations/2026-05-19-add-chameleon-calibrations.sql
sqlite3 conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  < database/migrations/2026-05-19-add-chameleon-calibrations.sql
```

- [ ] **Step 5: Commit**

```bash
git add database/migrations/2026-05-19-add-chameleon-calibrations.sql \
        database/seed-blank.sql \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
git commit -m "feat(chameleon): SQLite migration — global calibration table, drop per-device coefficients"
```

---

### Task B2: Update osi-chameleon-helper — lookup by array_id, drop defaults

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chameleon-helper/index.js`

- [ ] **Step 1: Rewrite the bcm2712 helper**

```javascript
'use strict';

const MAX_VALID_RESISTANCE_OHMS = 10000000;
const MIN_KPA = 0;
const MAX_KPA = 300;

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toFlag(value) {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true' || value.trim() === '1';
  return Number(value || 0) === 1;
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(value, min), max);
}

function normalizeArrayId(arrayId) {
  if (typeof arrayId !== 'string') return null;
  const upper = arrayId.toUpperCase();
  return /^[0-9A-F]{16}$/.test(upper) ? upper : null;
}

function calibrationFromArrayId(db, arrayId) {
  const normalized = normalizeArrayId(arrayId);
  if (!normalized) return null;
  const row = db.prepare(
    'SELECT sensor1_a, sensor1_b, sensor1_c, sensor2_a, sensor2_b, sensor2_c, ' +
    'sensor3_a, sensor3_b, sensor3_c FROM chameleon_calibrations WHERE array_id = ?'
  ).get(normalized);
  if (!row) return null;
  return {
    swt1: { a: row.sensor1_a, b: row.sensor1_b, c: row.sensor1_c },
    swt2: { a: row.sensor2_a, b: row.sensor2_b, c: row.sensor2_c },
    swt3: { a: row.sensor3_a, b: row.sensor3_b, c: row.sensor3_c },
  };
}

function resistanceOhmsToKpa(ohms, coefficients) {
  const resistanceOhms = toFiniteNumber(ohms);
  if (!coefficients || resistanceOhms === null
      || resistanceOhms <= 0 || resistanceOhms >= MAX_VALID_RESISTANCE_OHMS) {
    return null;
  }
  const resistanceKOhms = resistanceOhms / 1000;
  const kpa = coefficients.a * Math.log(resistanceKOhms)
            + coefficients.b * resistanceKOhms
            + coefficients.c;
  if (!Number.isFinite(kpa)) return null;
  return roundTo(clamp(kpa, MIN_KPA, MAX_KPA), 2);
}

function buildChameleonSwtMetrics(sample = {}, options = {}) {
  const { enabled = false, calibration = null } = options;
  const dataInvalid = toFlag(sample.i2cMissing) || toFlag(sample.timeout);
  const usable = enabled && !dataInvalid && calibration !== null;
  return {
    enabled: Boolean(enabled),
    dataInvalid,
    calibrationStatus: calibration === null
      ? (enabled ? 'pending' : 'calibrated')
      : 'calibrated',
    swt1Kpa: usable && !toFlag(sample.ch1Open)
      ? resistanceOhmsToKpa(sample.r1OhmComp, calibration.swt1) : null,
    swt2Kpa: usable && !toFlag(sample.ch2Open)
      ? resistanceOhmsToKpa(sample.r2OhmComp, calibration.swt2) : null,
    swt3Kpa: usable && !toFlag(sample.ch3Open)
      ? resistanceOhmsToKpa(sample.r3OhmComp, calibration.swt3) : null,
  };
}

module.exports = {
  MAX_VALID_RESISTANCE_OHMS,
  normalizeArrayId,
  calibrationFromArrayId,
  resistanceOhmsToKpa,
  buildChameleonSwtMetrics,
  toFiniteNumber,
};
```

- [ ] **Step 2: Mirror the change to bcm2709 helper**

Copy the same file content into `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chameleon-helper/index.js`. The two helpers must stay byte-identical.

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chameleon-helper/index.js
diff conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js \
     conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chameleon-helper/index.js
```

Expected: diff produces no output.

- [ ] **Step 3: Smoke-test the helper standalone**

```bash
node -e "
const better = require('better-sqlite3');
const db = better(':memory:');
db.exec('CREATE TABLE chameleon_calibrations(array_id TEXT PRIMARY KEY, sensor_id TEXT, sensor1_a REAL, sensor1_b REAL, sensor1_c REAL, sensor2_a REAL, sensor2_b REAL, sensor2_c REAL, sensor3_a REAL, sensor3_b REAL, sensor3_c REAL)');
db.exec(\"INSERT INTO chameleon_calibrations VALUES('28F8B2B40F0000C1','F8C1',9.81,0.13,6.4,9.98,0.13,6.63,9.7,0.12,5.79)\");
const h = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper');
console.log('Lookup uppercase:', h.calibrationFromArrayId(db, '28F8B2B40F0000C1') ? 'ok' : 'fail');
console.log('Lookup lowercase normalizes:', h.calibrationFromArrayId(db, '28f8b2b40f0000c1') ? 'ok' : 'fail');
console.log('Unknown ID returns null:', h.calibrationFromArrayId(db, '0000000000000000') === null ? 'ok' : 'fail');
const m = h.buildChameleonSwtMetrics({r1OhmComp: 10000, r2OhmComp: 20000, r3OhmComp: 30000}, {enabled: true, calibration: h.calibrationFromArrayId(db, '28F8B2B40F0000C1')});
console.log('kPa:', m.swt1Kpa, m.swt2Kpa, m.swt3Kpa);
console.log('Status:', m.calibrationStatus);
"
```

Expected: all three "ok" lines, three numeric kPa values, status `calibrated`. (If `better-sqlite3` isn't installed at repo root, use the version in the helper's `package.json` or run inside the helper directory.)

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chameleon-helper/index.js
git commit -m "feat(chameleon): helper looks up calibration by array_id, drop DEFAULT_CALIBRATION"
```

---

### Task B3: flows.json — sync worker for calibration fetch + backfill (bcm2712)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`

> flows.json is a single-line minified JSON file. Edits use `node` scripts that parse → mutate → re-serialize, not direct text edits.

- [ ] **Step 1: Write a flows-edit helper script (one-off, not committed)**

Create `/tmp/edit-flows-b3.js`:

```javascript
const fs = require('fs');
const path = process.argv[2];
const flows = JSON.parse(fs.readFileSync(path, 'utf8'));

// Locate the existing 30s sync poll trigger. Search by name; alter the existing function
// node it feeds into so it ALSO queries for missing calibrations.
const targetNodeName = 'sync-poll'; // verify by grepping; adjust if different
// ... see Step 2 for the actual insertion details
fs.writeFileSync(path, JSON.stringify(flows));
```

Implementation note: rather than scripting blindly, the executor should open flows.json in an editor (or use `jq` interactively) to identify the existing sync-poll subflow. The concrete nodes to add are described in Step 2.

- [ ] **Step 2: Add the calibration-fetch nodes**

Insert (into the sync poll subflow) a sequence of nodes:

1. **`calibration-missing-query` function node** — runs:
   ```sql
   SELECT DISTINCT cr.array_id AS array_id
     FROM chameleon_readings cr
    WHERE cr.array_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM chameleon_calibrations cc WHERE cc.array_id = cr.array_id)
      AND NOT EXISTS (
        SELECT 1 FROM chameleon_calibration_misses cm
         WHERE cm.array_id = cr.array_id
           AND datetime(cm.last_tried) > datetime('now', '-24 hours')
      )
   ```
   Outputs `msg.payload.array_ids = [...]` or skips downstream if empty.

2. **`calibration-batch-fetch` http-request node** — POST to `${SYNC_BASE}/api/v1/sync/chameleon/calibrations/lookup` with the JWT auth header that the existing sync poll already sets. Body: `{"array_ids": msg.payload.array_ids}`.

3. **`calibration-persist` function node** — for each `calibrations[i]`: INSERT OR REPLACE into `chameleon_calibrations`, UPDATE `chameleon_readings.calibration_status = 'calibrated'` WHERE `array_id` matches, then call into a local-backfill helper. For each `not_found[i]`: INSERT into `chameleon_calibration_misses(array_id, last_tried, reason) VALUES (?, datetime('now'), 'not_found')`, UPDATE `chameleon_readings.calibration_status = 'unknown'` WHERE `array_id` matches.

4. **`calibration-local-backfill` function node** — for each newly-inserted calibration, SELECT chameleon_readings rows for that array_id joined to device_data where swt_* are NULL, compute kPa using the same formula as the helper, UPDATE device_data.swt_*. All UPDATEs inside one `BEGIN; ... COMMIT;` transaction. **Do not enqueue outbox events**.

Each node carries explicit `id`, `name`, `wires` arrays following the surrounding pattern. To learn the existing pattern, dump the current sync-poll subflow:

```bash
node -e "
const flows = JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8'));
const sync = flows.filter(n => n.name && (n.name.includes('sync') || n.name.includes('outbox') || n.name.includes('pending')));
console.log(JSON.stringify(sync.map(n => ({id:n.id, type:n.type, name:n.name})), null, 2));
"
```

Use this output to position the new nodes in the existing subflow (most likely chained after the pending-commands fetch, before the outbox-deliver step).

- [ ] **Step 3: Mirror to bcm2709**

```bash
node /tmp/edit-flows-b3.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
diff <(node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'))).slice(0,200))") \
     <(node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'))).slice(0,200))")
```

- [ ] **Step 4: Validate JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'))" && echo "ok bcm2712"
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'))" && echo "ok bcm2709"
```

Expected: two `ok` lines.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(chameleon): sync worker fetches missing calibrations and runs local backfill"
```

---

### Task B4: flows.json — manual refresh endpoint + decoder integration

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`

- [ ] **Step 1: Add the refresh HTTP endpoint nodes**

Insert into both flows:

1. **`chameleon-refresh-http` http-in node** — `POST /api/devices/:deveui/chameleon/refresh-calibration`, attached to the existing GUI-auth chain.
2. **`chameleon-refresh-fn` function node** — body:
   ```javascript
   const deveui = msg.req.params.deveui;
   const row = db.prepare(
     "SELECT array_id FROM chameleon_readings WHERE deveui = ? AND array_id IS NOT NULL " +
     "ORDER BY recorded_at DESC LIMIT 1"
   ).get(deveui);
   if (!row) { msg.statusCode = 404; msg.payload = {error: 'no_array_id_seen'}; return [null, msg]; }
   msg.payload = { arrayId: row.array_id };
   return [msg, null];
   ```
3. **`chameleon-refresh-fetch` http-request node** — GET to `${SYNC_BASE}/api/v1/sync/chameleon/calibrations/${msg.payload.arrayId}`.
4. **`chameleon-refresh-persist` function node** — on 200, INSERT OR REPLACE into `chameleon_calibrations`, update statuses, run local backfill; on 404, INSERT into `chameleon_calibration_misses`. Return `{status, source, sensor_id}` to the HTTP response.
5. **`chameleon-refresh-response` http-response node** — sends the JSON back to the GUI.

- [ ] **Step 2: Update the LSN50 Chameleon decoder branch to use the new helper signature**

Locate the function node that processes Chameleon readings and currently calls `buildChameleonSwtMetrics(sample, calibrationFromDeviceRow(deviceRow))`. Change it to:

```javascript
const helper = global.get('chameleonHelper');
const calibration = helper.calibrationFromArrayId(db, reading.array_id);
const metrics = helper.buildChameleonSwtMetrics(reading, {
  enabled: Number(deviceRow.chameleon_enabled || 0) === 1,
  calibration,
});
// Persist calibrationStatus on chameleon_readings:
db.prepare(
  "UPDATE chameleon_readings SET calibration_status = ? WHERE id = ?"
).run(metrics.calibrationStatus, reading.id);
```

(Adjust the function-node body and variable names to match the existing flow conventions — the executor reads the surrounding nodes first to match style.)

- [ ] **Step 3: Validate JSON parses, both files**

```bash
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'))" && echo "ok bcm2712"
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'))" && echo "ok bcm2709"
```

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(chameleon): manual refresh endpoint + decoder calibration_status persistence"
```

---

### Task B5: flows.json — remove old chameleon-config endpoint

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`

- [ ] **Step 1: Identify the nodes to delete**

```bash
node -e "
const flows = JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8'));
console.log(JSON.stringify(flows.filter(n => n.name && n.name.includes('chameleon-config')).map(n => ({id:n.id, name:n.name, type:n.type})), null, 2));
"
```

Expected: 3 entries (`chameleon-config-http`, `chameleon-config`, `chameleon-config-auth-fn`). Note their `id`s.

- [ ] **Step 2: Delete nodes by id**

```bash
node -e "
const fs = require('fs');
for (const path of [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
]) {
  const flows = JSON.parse(fs.readFileSync(path, 'utf8'));
  const toRemove = new Set(flows.filter(n => n.name && n.name.includes('chameleon-config')).map(n => n.id));
  const pruned = flows.filter(n => !toRemove.has(n.id));
  // Also rewire any nodes that referenced removed nodes:
  for (const n of pruned) {
    if (Array.isArray(n.wires)) {
      n.wires = n.wires.map(arr => arr.filter(id => !toRemove.has(id)));
    }
  }
  fs.writeFileSync(path, JSON.stringify(pruned));
}
console.log('done');
"
```

- [ ] **Step 3: Verify no orphan references**

```bash
node -e "
const flows = JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'));
const ids = new Set(flows.map(n => n.id));
for (const n of flows) {
  if (!Array.isArray(n.wires)) continue;
  for (const arr of n.wires) for (const id of arr) if (!ids.has(id))
    console.log('orphan ref', n.id, '->', id);
}
console.log('check done');
" && node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'))" && echo "ok"
```

Expected: no "orphan ref" lines.

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "refactor(chameleon): remove obsolete chameleon-config Node-RED endpoint"
```

---

### Task B6: React types — drop coefficient fields, add calibration_status

**Files:**
- Modify: `web/react-gui/src/types/farming.ts`
- Modify: `web/react-gui/src/services/api.ts`

- [ ] **Step 1: In `farming.ts`, remove the 9 coefficient fields**

Find the type declaration containing `chameleon_swt1_a` (line ~113). Delete the 9 fields:

```typescript
// DELETE:
chameleon_swt1_a?: number | null;
chameleon_swt1_b?: number | null;
chameleon_swt1_c?: number | null;
chameleon_swt2_a?: number | null;
chameleon_swt2_b?: number | null;
chameleon_swt2_c?: number | null;
chameleon_swt3_a?: number | null;
chameleon_swt3_b?: number | null;
chameleon_swt3_c?: number | null;
```

Keep `chameleon_enabled` and the three `chameleon_swt[123]_depth_cm` fields.

- [ ] **Step 2: Add `calibration_status` to the history row type**

In the same file, locate the type used for `device_data` history rows (likely `DeviceHistoryRow` or similar). Add:

```typescript
calibration_status?: 'calibrated' | 'pending' | 'unknown' | null;
```

- [ ] **Step 3: In `api.ts`, remove `ChameleonConfigPayload` interface and `setChameleonConfig`**

Delete the interface (around line 368) and the method (around line 419).

- [ ] **Step 4: Add the refresh-calibration client method**

In the same exported object (where `setChameleonConfig` was), add:

```typescript
refreshChameleonCalibration: async (deveui: string): Promise<{
  status: 'calibrated' | 'pending' | 'unknown';
  source?: string;
  sensor_id?: string;
}> => {
  const res = await api.post(`/api/devices/${deveui}/chameleon/refresh-calibration`);
  return res.data;
},
```

- [ ] **Step 5: Run TypeScript build**

```bash
cd web/react-gui && npm run build 2>&1 | tail -40
```

Expected: any compile errors are reported from `DraginoChameleonSwtSection.tsx` (which still references the removed types) — that's the next task. No errors elsewhere.

- [ ] **Step 6: Commit (leave the broken component for Task B7)**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/types/farming.ts web/react-gui/src/services/api.ts
git commit -m "refactor(chameleon): drop coefficient types, add refresh + calibration_status types"
```

---

### Task B7: GUI — replace coefficient editor with read-only status block

**Files:**
- Modify: `web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx`

- [ ] **Step 1: Read the current component**

```bash
wc -l web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx
sed -n '1,60p' web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx
```

Note the imports, props interface, and surrounding styling patterns.

- [ ] **Step 2: Rewrite the calibration block**

Replace the section that renders the coefficient inputs (and any code that builds the `ChameleonConfigPayload`) with this read-only block:

```tsx
function ChameleonHardwareInfo({
  arrayId,
  status,
  source,
  onRefresh,
  refreshing,
}: {
  arrayId: string | null;
  status: 'calibrated' | 'pending' | 'unknown' | null;
  source: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const shortId = arrayId ? arrayId.slice(2, 4) + arrayId.slice(14, 16) : null;
  const badge = status === 'calibrated'
    ? { label: 'Calibrated', tone: 'success' as const }
    : status === 'pending'
      ? { label: 'Pending sync…', tone: 'warning' as const }
      : status === 'unknown'
        ? { label: 'Calibration unavailable', tone: 'neutral' as const }
        : { label: 'No reading yet', tone: 'neutral' as const };
  return (
    <div className="chameleon-hardware-info">
      <div className="ids">
        {shortId && <div className="sensor-id">{shortId}</div>}
        {arrayId && <div className="array-id"><code>{arrayId}</code></div>}
      </div>
      <div className={`status-badge tone-${badge.tone}`}>{badge.label}</div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing || !arrayId}
      >
        {refreshing ? 'Refreshing…' : 'Refresh calibration'}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Wire up state + handler in the parent component**

In the parent component (the one that currently calls `setChameleonConfig`), remove the coefficient form state. Add:

```tsx
const [refreshing, setRefreshing] = React.useState(false);
const [calibStatus, setCalibStatus] = React.useState<'calibrated' | 'pending' | 'unknown' | null>(null);
const [calibSource, setCalibSource] = React.useState<string | null>(null);

// Initial status from latest reading prop:
React.useEffect(() => {
  setCalibStatus(latestReading?.calibration_status ?? null);
}, [latestReading]);

const handleRefresh = async () => {
  setRefreshing(true);
  try {
    const result = await lsn50API.refreshChameleonCalibration(device.deveui);
    setCalibStatus(result.status);
    setCalibSource(result.source ?? null);
  } finally {
    setRefreshing(false);
  }
};
```

Pass `arrayId = latestReading?.array_id ?? null`, the state values, and the handler to `<ChameleonHardwareInfo />`.

- [ ] **Step 4: Keep depth fields editable, wire to existing depth-save mechanism**

The component currently has depth inputs paired with the coefficient inputs and saves both together via `setChameleonConfig`. After this task: depth still saves via an existing or new endpoint that updates only the depth columns. If the existing flows.json endpoint that handled `setChameleonConfig` was the only depth save path (which it was, since it was removed in Task B5), Task B5's commit message lied — we need to ADD a depth-only save endpoint in flows.json. Add this now as part of this task instead of in B5:

Add to both flows.json files (Node-RED): an HTTP-in node `POST /api/devices/:deveui/chameleon/depth` whose function body validates and updates only `devices.chameleon_swt[123]_depth_cm` and `devices.chameleon_enabled`. Wire to the same auth chain. Add a corresponding client method `setChameleonDepth(deveui, { chameleon_enabled, chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm })` in `api.ts`. Update the depth-input handler in this React component to call the new method.

- [ ] **Step 5: Re-validate flows.json parse**

```bash
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'))" && echo "ok"
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'))" && echo "ok"
```

- [ ] **Step 6: Build the React app**

```bash
cd web/react-gui && npm run build 2>&1 | tail -20
```

Expected: BUILD success, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx \
        web/react-gui/src/services/api.ts \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(chameleon): read-only GUI block with refresh button, depth-only save endpoint"
```

---

### Task B8: GUI — history payload + chart status indicators

**Files:**
- Modify: `web/react-gui/src/types/farming.ts` (if not done in B6)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (history endpoint)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: the chart component that renders SWT history (search for it in step 1)

- [ ] **Step 1: Find the chart component**

```bash
grep -rn "swt_1\|swt_2\|swt_3" web/react-gui/src --include="*.tsx" --include="*.ts" | grep -v node_modules | head -20
```

Identify the component(s) that render SWT history. Note the file paths.

- [ ] **Step 2: Update the history Node-RED handler to include `calibration_status`**

In the function node that serves `GET /api/devices/history` (or similar), modify the SELECT to LEFT JOIN `chameleon_readings` on `(deveui, recorded_at)` and SELECT `cr.calibration_status` as part of the payload. Add the field to each row in the response.

- [ ] **Step 3: Update the chart component(s) to render based on status**

For each SWT data point, if `calibration_status === 'pending'` or `=== 'unknown'`, render the point in a muted color (e.g., gray dot, opacity 0.4) instead of the normal series color. Keep tooltips functional. Add a chart legend/footnote when at least one muted point is visible: "Gray points: calibration unavailable at sync time."

- [ ] **Step 4: Build**

```bash
cd web/react-gui && npm run build 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(chameleon): history payload carries calibration_status, chart dims pending points"
```

---

### Task B9: Build-time refresh script

**Files:**
- Create: `scripts/refresh-chameleon-calibrations.js`
- Create: `database/seeds/chameleon-calibrations.sql` (initially empty placeholder)

- [ ] **Step 1: Write the seed file placeholder**

```bash
mkdir -p database/seeds
cat > database/seeds/chameleon-calibrations.sql <<'EOF'
-- Generated by scripts/refresh-chameleon-calibrations.js
-- Run before each release to bundle known calibrations into the firmware seed DB.
EOF
```

- [ ] **Step 2: Write the refresh script**

```javascript
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const SERVER = process.env.OSI_SERVER_BASE_URL || 'https://server.opensmartirrigation.org';
const ADMIN_TOKEN = process.env.OSI_ADMIN_TOKEN;
const OUT_PATH = path.resolve(__dirname, '..', 'database', 'seeds', 'chameleon-calibrations.sql');

if (!ADMIN_TOKEN) {
  console.error('Set OSI_ADMIN_TOKEN to run this script.');
  process.exit(1);
}

function fetchDump() {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/admin/chameleon/calibrations', SERVER);
    const req = https.request({
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname,
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sqlQuote(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function rowSql(row) {
  const cols = [
    'array_id','sensor_id',
    'sensor1_a','sensor1_b','sensor1_c','sensor1_r2',
    'sensor2_a','sensor2_b','sensor2_c','sensor2_r2',
    'sensor3_a','sensor3_b','sensor3_c','sensor3_r2',
    'test_rig_run_start_date','source','fetched_at',
  ];
  const vals = [
    row.array_id, row.sensor_id,
    row.sensor1_a, row.sensor1_b, row.sensor1_c, row.sensor1_r2,
    row.sensor2_a, row.sensor2_b, row.sensor2_c, row.sensor2_r2,
    row.sensor3_a, row.sensor3_b, row.sensor3_c, row.sensor3_r2,
    row.test_rig_run_start_date, 'bundled', new Date().toISOString(),
  ].map(sqlQuote);
  return `INSERT OR IGNORE INTO chameleon_calibrations (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

(async () => {
  const rows = await fetchDump();
  rows.sort((a, b) => a.array_id.localeCompare(b.array_id));
  const lines = [
    '-- Generated by scripts/refresh-chameleon-calibrations.js',
    `-- Source: ${SERVER}`,
    `-- Generated: ${new Date().toISOString()}`,
    `-- Row count: ${rows.length}`,
    '',
    ...rows.map(rowSql),
    '',
  ];
  fs.writeFileSync(OUT_PATH, lines.join('\n'));
  console.log(`Wrote ${rows.length} rows to ${OUT_PATH}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Make executable**

```bash
chmod +x scripts/refresh-chameleon-calibrations.js
```

- [ ] **Step 4: Dry-run against staging if available**

```bash
OSI_ADMIN_TOKEN=stagingtoken node scripts/refresh-chameleon-calibrations.js 2>&1 | head
```

If staging admin auth isn't reachable from the dev workstation: skip this step but note it in the commit message — the release-cut maintainer will test the script the first time it's used.

- [ ] **Step 5: Commit**

```bash
git add scripts/refresh-chameleon-calibrations.js database/seeds/chameleon-calibrations.sql
git commit -m "feat(chameleon): release-cut script to bundle known calibrations into firmware"
```

---

### Task B10: Wire the bundled seed into farming.db build

**Files:**
- Modify: existing seed-DB build script (locate via grep)

- [ ] **Step 1: Locate the seed-DB build step**

```bash
grep -rn "seed-blank.sql\|farming.db" scripts/ Makefile 2>/dev/null | head -20
```

Identify where `seed-blank.sql` is applied to produce `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`. There's likely a `scripts/build-farming-db.js` or a Makefile target.

- [ ] **Step 2: After the schema is applied, also apply the calibrations seed**

Add to the build step (sequenced after `seed-blank.sql`):

```bash
sqlite3 "$OUT" < database/seeds/chameleon-calibrations.sql
```

(Adjust the variable name to match the surrounding script.) Apply to both bcm2712 and bcm2709 seed DBs.

- [ ] **Step 3: Rebuild the seed DB and verify**

```bash
# Run whatever the existing build command is:
make seed-farming-db 2>/dev/null || node scripts/build-farming-db.js 2>/dev/null
sqlite3 conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  "SELECT COUNT(*) FROM chameleon_calibrations;"
```

Expected: 0 rows for the placeholder seed; after the maintainer runs `refresh-chameleon-calibrations.js`, this number becomes the bundled count.

- [ ] **Step 4: Commit**

```bash
git add Makefile scripts/build-farming-db.js  # whichever was modified
git commit -m "feat(chameleon): apply calibrations seed during firmware build"
```

---

### Task B11: Edge tests — verify-chameleon-calibration.js + update existing verifiers

**Files:**
- Create: `scripts/verify-chameleon-calibration.js`
- Modify: `scripts/verify-lsn50-chameleon-persistence.js`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Write the new verifier**

```javascript
#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const sqlite = require('better-sqlite3');
const helper = require(path.resolve(__dirname, '..',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper'));

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }
function ok(msg) { console.log('ok -', msg); }

function setup() {
  const db = sqlite(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'database/seed-blank.sql'), 'utf8'));
  // Insert a minimal LSN50 device:
  db.prepare("INSERT INTO devices(deveui, type_id, chameleon_enabled) VALUES(?, ?, 1)")
    .run('0000000000000001', 'DRAGINO_LSN50');
  return db;
}

(function () {
  const db = setup();
  const ts = '2026-05-19T12:00:00.000Z';
  const arrayId = '28F8B2B40F0000C1';

  // Test 1: Reading with unknown array_id → calibration_status='pending', NULL kPa
  db.prepare("INSERT INTO chameleon_readings(deveui, recorded_at, array_id, r1_ohm_comp, r2_ohm_comp, r3_ohm_comp) VALUES(?, ?, ?, ?, ?, ?)")
    .run('0000000000000001', ts, arrayId, 10000, 20000, 30000);
  let calibration = helper.calibrationFromArrayId(db, arrayId);
  if (calibration !== null) fail('expected null calibration for unknown array_id');
  ok('unknown array_id returns null calibration');

  // Test 2: Insert calibration, run helper → kPa populated
  db.prepare("INSERT INTO chameleon_calibrations(array_id, sensor_id, sensor1_a, sensor1_b, sensor1_c, sensor2_a, sensor2_b, sensor2_c, sensor3_a, sensor3_b, sensor3_c, source, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(arrayId, 'F8C1', 9.81, 0.13, 6.4, 9.98, 0.13, 6.63, 9.7, 0.12, 5.79, 'via_api', new Date().toISOString());
  calibration = helper.calibrationFromArrayId(db, arrayId);
  if (!calibration) fail('expected calibration after insert');
  const metrics = helper.buildChameleonSwtMetrics(
    { r1OhmComp: 10000, r2OhmComp: 20000, r3OhmComp: 30000 },
    { enabled: true, calibration }
  );
  if (metrics.swt1Kpa === null || metrics.swt2Kpa === null || metrics.swt3Kpa === null) {
    fail('expected non-null kPa for all 3 sensors');
  }
  ok('kPa computed for all 3 sensors after calibration insert');

  // Test 3: Mixed-case input normalized to uppercase
  if (helper.calibrationFromArrayId(db, arrayId.toLowerCase()) === null) {
    fail('mixed-case array_id should normalize and hit cache');
  }
  ok('mixed-case array_id normalized');

  // Test 4: Calibration disabled → no kPa even when calibration present
  const disabled = helper.buildChameleonSwtMetrics(
    { r1OhmComp: 10000, r2OhmComp: 20000, r3OhmComp: 30000 },
    { enabled: false, calibration }
  );
  if (disabled.swt1Kpa !== null) fail('disabled chameleon should not emit kPa');
  ok('disabled chameleon emits no kPa');

  // Test 5: Miss table TTL (24h)
  db.prepare("INSERT INTO chameleon_calibration_misses(array_id, last_tried, reason) VALUES(?, ?, ?)")
    .run('0000000000000002', new Date(Date.now() - 25 * 3600 * 1000).toISOString(), 'not_found');
  const expiredMiss = db.prepare(
    "SELECT COUNT(*) AS n FROM chameleon_calibration_misses " +
    "WHERE array_id = ? AND datetime(last_tried) > datetime('now', '-24 hours')"
  ).get('0000000000000002');
  if (expiredMiss.n !== 0) fail('expected expired miss to be excluded by TTL filter');
  ok('expired miss row not selected by 24h TTL query');

  console.log('verify-chameleon-calibration PASS');
})();
```

- [ ] **Step 2: Run it**

```bash
chmod +x scripts/verify-chameleon-calibration.js
node scripts/verify-chameleon-calibration.js
```

Expected: 5 "ok" lines + "verify-chameleon-calibration PASS".

- [ ] **Step 3: Update verify-lsn50-chameleon-persistence.js**

Open the existing script and:
- Replace any references to `chameleon_swt[123]_[abc]` on the `devices` table with lookups against `chameleon_calibrations`
- Remove assertions on default fallback values (now no defaults)
- Add an assertion that `chameleon_readings.calibration_status` is populated post-decode

- [ ] **Step 4: Update verify-sync-flow.js**

Add coverage for the new `/api/v1/sync/chameleon/calibrations/lookup` endpoint:
- Mock or skip if osi-server isn't reachable; otherwise POST a batch and assert the response shape

- [ ] **Step 5: Run all three verifiers**

```bash
node scripts/verify-chameleon-calibration.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-sync-flow.js
```

Expected: all pass.

- [ ] **Step 6: Chain into profile-parity / Makefile**

If there's a `make verify` target or a chain in `scripts/verify-sync-flow.js`, add `verify-chameleon-calibration.js` to it so CI runs it.

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-chameleon-calibration.js \
        scripts/verify-lsn50-chameleon-persistence.js \
        scripts/verify-sync-flow.js \
        Makefile  # if modified
git commit -m "test(chameleon): verify-chameleon-calibration + update existing edge verifiers"
```

---

### Task B12: Documentation updates

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/versioning-workflow.md`
- Modify: `/home/phil/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md`

- [ ] **Step 1: Update AGENTS.md**

Add a short subsection under existing schema docs describing:
- `chameleon_calibrations` table is keyed by array_id (uppercase hex), source is via.farm
- Per-device coefficient columns dropped in 2026-05-19 migration
- New endpoint `POST /api/devices/:deveui/chameleon/refresh-calibration` (Node-RED)
- New endpoint `POST /api/devices/:deveui/chameleon/depth` (Node-RED)

- [ ] **Step 2: Update versioning-workflow.md**

Add to the release checklist:
> Before cutting a release: `OSI_ADMIN_TOKEN=… node scripts/refresh-chameleon-calibrations.js`. Review the diff in `database/seeds/chameleon-calibrations.sql` and commit it as part of the release PR.

- [ ] **Step 3: Update MEMORY.md**

Add a note under the device-inventory section that hand-entered per-device calibration is discarded by V42; operators verify post-upgrade that each live array_id has a row in `chameleon_calibrations` (either bundled or fetched).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/versioning-workflow.md \
        /home/phil/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md
git commit -m "docs: chameleon global calibration table — operator + release notes"
```

---

### Task B13: End-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Stand up osi-server with a clean DB**

In `/home/phil/Repos/osi-server`: `./gradlew bootRun` with `VIA_FARM_API_TOKEN=…`.

- [ ] **Step 2: Verify lookup endpoint returns 200 for a known array_id**

```bash
curl -sS -H "Authorization: Bearer ${EDGE_JWT}" \
  "http://localhost:8080/api/v1/sync/chameleon/calibrations/28F8B2B40F0000C1" | jq .
```

Expected: 200 with all 9 coefficients + sensor_id `F8C1`.

- [ ] **Step 3: Verify lookup endpoint returns 404 for an unknown array_id**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer ${EDGE_JWT}" \
  "http://localhost:8080/api/v1/sync/chameleon/calibrations/0000000000000000"
```

Expected: `404`.

- [ ] **Step 4: Run all chameleon tests once more**

```bash
cd /home/phil/Repos/osi-server && ./gradlew test --tests "org.osi.server.chameleon.*" --tests "org.osi.server.device.*"
cd /home/phil/Repos/osi-os && node scripts/verify-chameleon-calibration.js && node scripts/verify-lsn50-chameleon-persistence.js
```

Expected: all green.

- [ ] **Step 5: No commit; record verification in the PR description.**

---

## Plan self-review

**Spec coverage check:**
- Schema (`chameleon_calibrations`, `chameleon_calibration_misses`, `calibration_status`): A1, B1 ✓
- Drop 9 per-device columns + NULL stale device_data: A1, B1 ✓
- `array_id` uppercase normalization: A2, B2 ✓
- Sensor ID derivation: A2 ✓
- via.farm client with 200/302/5xx handling: A5 ✓
- Cache-aside + negative cache (24h TTL): A6 ✓
- Edge endpoints (single, batch): A7 ✓
- Admin endpoints (refresh, dump): A8 ✓
- Cloud-side recompute (KpaCurve, on calibration arrival + readings ingest): A9 ✓
- Retire PUT /chameleon-config + DTOs: A10 ✓
- Integration test against via.farm mock: A11 ✓
- Helper update with new `(enabled, calibration)` signature: B2 ✓
- Sync worker (lazy fetch, miss-table-aware query): B3 ✓
- Local backfill: B3 ✓
- Manual refresh endpoint + decoder integration: B4 ✓
- Retire old chameleon-config Node-RED endpoint: B5 ✓
- Add depth-only save endpoint: B7 (moved here because B5 removed the only depth-save path) ✓
- GUI types + service client: B6 ✓
- GUI read-only block + refresh button: B7 ✓
- History payload + chart status: B8 ✓
- Build-time refresh script + bundled seed: B9 ✓
- Seed wired into farming.db build: B10 ✓
- Edge tests: B11 ✓
- Docs (AGENTS.md, versioning-workflow.md, MEMORY.md): A12, B12 ✓

**Placeholder scan:** No "TBD" / "implement later". A few "verify by grepping; adjust if different" notes appear in B3/B5 — these are explicit "context-dependent identifier lookup" instructions, not placeholder logic. They're acceptable because flows.json node IDs cannot be hardcoded.

**Type consistency check:** Helper signature is `buildChameleonSwtMetrics(sample, { enabled, calibration })` throughout (B2, B4). Server records use snake_case JSON fields (`sensor1_a`) matching the DB schema. Status enum is `'calibrated' | 'pending' | 'unknown'` everywhere.

---

## Execution Handoff

Plan complete and saved to [docs/superpowers/plans/2026-05-19-chameleon-calibration-global-table.md](docs/superpowers/plans/2026-05-19-chameleon-calibration-global-table.md). Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
