# Sync-Ingest Hardening (refactor-program 1.B4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Repo split:** this plan file lives in **osi-os** (docs home), but **every code change is in `/home/phil/Repos/osi-server`** — branch `feat/sync-ingest-hardening`, PR in the osi-server repo, **do not merge**. Zero osi-os file changes.
> **Execution notes:** (1) work on a feature branch/worktree of osi-server `main`, run all commands from `/home/phil/Repos/osi-server/backend`; (2) **osi-server has NO CI** — every gate here is LOCAL `./gradlew test`; the frontend builds hook `processResources`, so the fast iteration variant is `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend` (per osi-server AGENTS.md) — run the un-skipped full `./gradlew test` at least once before the PR; (3) **Docker must be running locally** — Testcontainers starts one Postgres 16 container for the whole test JVM; without Docker the IT classes fail at container startup; (4) before creating the Flyway migration, re-verify the highest applied version — a concurrent merge could bump it past `V2026_07_06_001__agroscope_shadow.sql` (check `ls backend/src/main/resources/db/migration/ | sort` in-repo; on a live DB the check is `SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 5;` per AGENTS.md) — if it moved, rename this plan's migration to sort after the new highest.
> **Spec:** [`docs/superpowers/specs/2026-07-07-sync-ingest-hardening-design.md`](../specs/2026-07-07-sync-ingest-hardening-design.md) (approved; §A–§G references point there). **Hard gate for #87 — the Uganda catch-up must not run before this merges and deploys.**

**Goal:** Defuse the live poison-pill in `EdgeSyncService.applyEventsV2` (one bad event rolls back a whole 100-event batch, forever) by giving every event its own transaction; make dropped events forensically visible in a new `sync_dead_letter` table; cap batch size and rate-limit `/api/v1/sync/edge/events` per gateway; prove all of it against real Postgres 16 via Testcontainers — the first DB-backed tests this repo has ever had.

**Architecture (spec §A two-surface failure model):** a new `SyncEventTxExecutor` bean owns three narrow transactional methods — `applyOne(...)` (`REQUIRES_NEW`; body = today's `applyEventV2` minus the blanket `catch (Exception)`, plus a terminal `entityManager.flush()`), `recordRejection(...)` (`REQUIRES_NEW`; dead-letter + inbox rows in a fresh tx for flush/commit-time permanent faults), and `finalizeBatch(...)` (`@Transactional`; cursor + gateway last-seen). `applyEventsV2` becomes **non-transactional**: its loop try/catches each `applyOne` call — the loop is where flush-time and commit-time exceptions surface, because under `REQUIRES_NEW` the commit fires at the proxy boundary as `applyOne` returns — and classifies them via `SyncExceptionClassifier` (constraint violations → REJECTED `integrity_violation` + `recordRejection`; everything else → RETRYABLE, nothing persisted). The op-dispatch stays in `EdgeSyncService` and reaches the executor as a per-batch callback (`SyncOpDispatcher`), avoiding a circular bean dependency and leaving the DD12 applier split unblocked. Wire shape of `SyncEventBatchResponse` is unchanged — deployed edge flows keep working unmodified.

**Tech Stack:** Java 17 / Spring Boot 3.4.3, Lombok, Flyway (date-versioned), Bucket4j 8.10.1 (existing `RateLimitFilter` pattern), Testcontainers Postgres 16 (versions managed by the Spring Boot BOM), JUnit 5 + Mockito + AssertJ (existing conventions).

## Global Constraints

- **All code changes in osi-server only.** Branch `feat/sync-ingest-hardening`; commit per task; open a PR at the end; **do not merge it**. Never modify anything under `/home/phil/Repos/osi-os` in this plan.
- **The Flyway migration is additive only** (one new table + indexes; no ALTER on existing tables) and must sort after the current highest version (`V2026_07_06_001` at planning time — re-verify, see execution notes).
- **Wire compatibility is the point:** `SyncEventBatchResponse` / `SyncEventResult` JSON shape and the existing reason strings must not change. Verified edge behavior this design leans on: edge caps itself at `LIMIT 100`/30 s; treats every non-2xx (429/400 included) as leave-rows-untouched-retry-next-tick; treats `REJECTED` as terminal (`rejected_at` set, never re-sent).
- **Never touch `applyBootstrap`, the V1 `applyEvents` path, or any other endpoint's behavior.** The V1 path keeps its batch transaction (legacy edges may depend on it; the #87 catch-up runs on current protocol-2 flows after a full deploy).
- **No production or test-server access.** Everything runs locally. No secrets in code or tests.
- Local gates per task; full suite (`cd backend && ./gradlew test`) green before the PR.
- Micrometer is **not** on the classpath at planning time (1.B3 not landed): per spec §D, the batch counters ship only if that changed — Task 5 has an explicit check step.

## Non-goals (do not do these)

- No `EdgeSyncService` split into per-resource appliers (DD12 / program 3.4) — the executor is shaped for it, nothing more.
- No CI workflow, GHCR, or deploy changes (1.B3). No bootstrap snapshot work (5.5).
- No runtime JSON-Schema validation (deferred to Phase 3 per spec §F — the `schema_violation` hook point is documented there, not built here).
- No attempt counters / retryable→dead-letter escalation (spec §B). No requeue endpoint (spec §D YAGNI).
- No edge-side (osi-os) changes of any kind, including flows.json.

## File Structure (all paths relative to `/home/phil/Repos/osi-server/backend`)

- Modify: `build.gradle.kts` (Task 1)
- Create: `src/test/java/org/osi/server/testsupport/PostgresSyncTestBase.java`, `src/test/java/org/osi/server/testsupport/FlywayMigrationIT.java` (Task 1)
- Create: `src/main/resources/db/migration/V2026_07_07_001__sync_dead_letter.sql`, `src/main/java/org/osi/server/sync/SyncDeadLetter.java`, `src/main/java/org/osi/server/sync/SyncDeadLetterRepository.java`, `src/test/java/org/osi/server/sync/SyncDeadLetterRepositoryIT.java` (Task 2)
- Create: `src/main/java/org/osi/server/sync/SyncExceptionClassifier.java`, `src/test/java/org/osi/server/sync/SyncExceptionClassifierTest.java` (Task 3)
- Create: `src/main/java/org/osi/server/sync/SyncEventShapes.java`, `src/main/java/org/osi/server/sync/SyncEventTxExecutor.java`, `src/test/java/org/osi/server/sync/PoisonBatchIT.java`; Modify: `src/main/java/org/osi/server/sync/EdgeSyncService.java` (Task 4)
- Create: `src/main/java/org/osi/server/retention/SyncDeadLetterRetentionJob.java`, `src/test/java/org/osi/server/retention/SyncDeadLetterRetentionJobTest.java`, `src/main/java/org/osi/server/sync/SyncDeadLetterResponse.java`, `src/main/java/org/osi/server/sync/SyncDeadLetterAdminController.java`, `src/test/java/org/osi/server/sync/SyncDeadLetterAdminControllerTest.java`; Modify: `src/main/java/org/osi/server/retention/DbHealthCounters.java` (Task 5)
- Modify: `src/main/java/org/osi/server/sync/EdgeSyncController.java`, `src/main/java/org/osi/server/security/RateLimitFilter.java`, `src/main/java/org/osi/server/config/SecurityConfig.java`, `src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java`; Create: `src/test/java/org/osi/server/security/RateLimitSyncEventsTest.java` (Task 6)
- Create: `src/test/java/org/osi/server/sync/BacklogDrainIT.java` (Task 7)

**Task-cut note (deviation from the suggested order, justified):** the suggested T1 (migration) and T2 (Testcontainers infra) are swapped — TDD on a Flyway migration needs the real-Postgres harness first, so the red/green cycle for `sync_dead_letter` ("table missing" → migration → green) is possible at all. Content is otherwise the suggested cut.

---

### Task 1: Testcontainers infrastructure + the first-ever Flyway-against-real-Postgres test

**Files:**
- Modify: `build.gradle.kts`
- Create: `src/test/java/org/osi/server/testsupport/PostgresSyncTestBase.java`
- Create: `src/test/java/org/osi/server/testsupport/FlywayMigrationIT.java`

**Interfaces:**
- Produces: a singleton Postgres 16 container (DD15 "single reused container") + datasource wiring consumed by every IT class in Tasks 2/4/7. Test classes carry their own `@DataJpaTest` + `@AutoConfigureTestDatabase(replace = NONE)` (explicit per class; only the container + `@DynamicPropertySource` are inherited). Because ONE database is shared across all IT classes, **every IT class must use its own unique gateway EUI / event-uuid prefix** — stated on the base class, enforced by convention.
- The Flyway clean-migrate test is new coverage the repo never had: 55 existing migrations (V2–V41 + dated) apply to a clean real Postgres or the suite fails.

- [ ] **Step 1.1: Create the branch**

```bash
cd /home/phil/Repos/osi-server && git checkout main && git pull --ff-only && git checkout -b feat/sync-ingest-hardening
```

- [ ] **Step 1.2: Add test dependencies** — in `backend/build.gradle.kts`, inside the `// Testing` block, after `testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")`, add:

```kotlin
    // Testcontainers (versions managed by the Spring Boot BOM) — sync/Flyway path only (DD15)
    testImplementation("org.testcontainers:junit-jupiter")
    testImplementation("org.testcontainers:postgresql")
```

- [ ] **Step 1.3: Write the base class** — create `src/test/java/org/osi/server/testsupport/PostgresSyncTestBase.java` with exactly:

```java
package org.osi.server.testsupport;

import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;

/**
 * Singleton-container base for the sync-path integration tests (DD15: Testcontainers
 * Postgres 16, ONE reused container, scoped to the sync/Flyway path — everything else
 * in this repo stays Mockito).
 *
 * The container is started eagerly in a static initializer rather than via
 * {@code @Container} so it is shared across ALL test classes in the JVM and reaped by
 * Ryuk at exit — the Testcontainers-documented singleton pattern.
 *
 * The ONE database is shared across every extending class (Flyway migrates it once;
 * later Spring contexts validate no-op). Therefore: every extending class MUST use its
 * own unique gateway EUI and event-uuid prefix — tests must never assume an empty DB.
 *
 * Subclasses declare their own @DataJpaTest + @AutoConfigureTestDatabase(replace = NONE)
 * (+ @Import/@MockBean); only the container and datasource properties live here.
 */
public abstract class PostgresSyncTestBase {

    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16-alpine");

    static {
        POSTGRES.start();
    }

    @DynamicPropertySource
    static void datasourceProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
    }
}
```

- [ ] **Step 1.4: Write the Flyway clean-migrate test** — create `src/test/java/org/osi/server/testsupport/FlywayMigrationIT.java` with exactly:

```java
package org.osi.server.testsupport;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * First DB-backed test in this repo: every Flyway migration applies cleanly to a
 * real, empty Postgres 16 (ground truth 5: "no test runs against Postgres or Flyway").
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class FlywayMigrationIT extends PostgresSyncTestBase {

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void allMigrationsApplyCleanlyOnRealPostgres() {
        Integer failed = jdbc.queryForObject(
                "SELECT COUNT(*) FROM flyway_schema_history WHERE success = false", Integer.class);
        assertThat(failed).isZero();
        Integer applied = jdbc.queryForObject(
                "SELECT COUNT(*) FROM flyway_schema_history WHERE success = true", Integer.class);
        assertThat(applied).isGreaterThanOrEqualTo(55);
    }

    @Test
    void syncHotPathTablesExist() {
        for (String table : new String[]{
                "sync_inbox", "sync_outbox", "sync_resource_watermarks", "sync_cursor",
                "sensor_data", "device_commands"}) {
            Integer n = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?",
                    Integer.class, table);
            assertThat(n).as(table).isEqualTo(1);
        }
    }
}
```

- [ ] **Step 1.5: Run it (green — this task is harness, the red/green cycle starts in Task 2)**

Run: `cd /home/phil/Repos/osi-server/backend && ./gradlew test --tests 'org.osi.server.testsupport.FlywayMigrationIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: container pulls/starts (first run downloads `postgres:16-alpine`), Flyway applies all migrations, `BUILD SUCCESSFUL`, 2 tests pass. If it fails with a Docker connection error, Docker is not running — start it; this is a stated local prerequisite.

- [ ] **Step 1.6: Commit**

```bash
git add build.gradle.kts src/test/java/org/osi/server/testsupport/
git commit -m "test: Testcontainers Postgres 16 singleton harness + first Flyway clean-migrate test (1.B4/DD15)"
```

---

### Task 2: `sync_dead_letter` — Flyway migration + entity + repository

**Files:**
- Create: `src/main/resources/db/migration/V2026_07_07_001__sync_dead_letter.sql`
- Create: `src/main/java/org/osi/server/sync/SyncDeadLetter.java`
- Create: `src/main/java/org/osi/server/sync/SyncDeadLetterRepository.java`
- Create: `src/test/java/org/osi/server/sync/SyncDeadLetterRepositoryIT.java`

**Interfaces:**
- Produces: the forensic table (spec §C) + `SyncDeadLetterRepository` (`existsByEventUuid` dedup pre-check, per-gateway listing, retention count/delete) consumed by Tasks 4/5/7.
- **Two deliberate deltas from the spec's §C sketch, both to report upward:** (1) `event_uuid` is **VARCHAR(64)**, not 36 — `sync_resource_watermarks.last_event_uuid` (64) is the precedent, and a malformed >36-char uuid (which `sync_inbox VARCHAR(36)` cannot store — that insert failing IS a dead-letter-worthy event, and exactly Task 4's repro) must itself be dead-letterable; (2) a third index `ix_sync_dead_letter_received_at` — the spec's composite `(gateway_eui, received_at)` cannot serve the retention job's pure `received_at < ?` range scan.

- [ ] **Step 2.1: Extend the Flyway test (red)** — in `FlywayMigrationIT.syncHotPathTablesExist`, add `"sync_dead_letter"` to the table array:

```java
        for (String table : new String[]{
                "sync_inbox", "sync_outbox", "sync_resource_watermarks", "sync_cursor",
                "sensor_data", "device_commands", "sync_dead_letter"}) {
```

Run: `./gradlew test --tests 'org.osi.server.testsupport.FlywayMigrationIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL — `[sync_dead_letter] expected: 1 but was: 0`.

- [ ] **Step 2.2: Verify the migration slot, then create the migration** — run `ls src/main/resources/db/migration/ | sort | tail -3`; expected highest: `V2026_07_06_001__agroscope_shadow.sql` (if higher exists, rename accordingly). Create `src/main/resources/db/migration/V2026_07_07_001__sync_dead_letter.sql` with exactly:

```sql
-- 1.B4 sync-ingest hardening (spec 2026-07-07-sync-ingest-hardening-design.md §C).
-- Forensic surface for rejected sync events: what did gateway X send that we
-- dropped, and why. Additive only. Separate from the hot sync_inbox dedup row
-- by design (do not widen the row every dedup check hits).
--
-- event_uuid is VARCHAR(64) — wider than sync_inbox's 36 — following the
-- sync_resource_watermarks.last_event_uuid precedent, so a malformed >36-char
-- uuid (unstorable in the inbox; exactly a dead-letter-worthy defect) can
-- itself be dead-lettered. reason is a short stable code (varchar, not a PG
-- enum, per house convention); free text goes in reason_detail.

CREATE TABLE sync_dead_letter (
    id                BIGSERIAL PRIMARY KEY,
    event_uuid        VARCHAR(64) NOT NULL,
    gateway_eui       VARCHAR(32) NOT NULL,
    source_node       VARCHAR(100),
    op                VARCHAR(50),
    aggregate_type    VARCHAR(50),
    aggregate_key     VARCHAR(100),
    payload           JSONB,
    reason            VARCHAR(50) NOT NULL,
    reason_detail     TEXT,
    contract_version  BIGINT,
    occurred_at       TIMESTAMPTZ,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup guarantee for re-sent duplicates of an already-dead-lettered event.
CREATE UNIQUE INDEX ux_sync_dead_letter_event_uuid ON sync_dead_letter (event_uuid);
-- Per-gateway listing (admin endpoint).
CREATE INDEX ix_sync_dead_letter_gateway_received ON sync_dead_letter (gateway_eui, received_at DESC);
-- Retention pruning (received_at < cutoff range scan).
CREATE INDEX ix_sync_dead_letter_received_at ON sync_dead_letter (received_at);
```

Run: `./gradlew test --tests 'org.osi.server.testsupport.FlywayMigrationIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: PASS (green) — new migration applies on clean Postgres.

- [ ] **Step 2.3: Write the failing repository IT** — create `src/test/java/org/osi/server/sync/SyncDeadLetterRepositoryIT.java` with exactly:

```java
package org.osi.server.sync;

import org.junit.jupiter.api.Test;
import org.osi.server.testsupport.PostgresSyncTestBase;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.dao.DataIntegrityViolationException;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class SyncDeadLetterRepositoryIT extends PostgresSyncTestBase {

    @Autowired
    private SyncDeadLetterRepository repository;

    private SyncDeadLetter row(String uuid) {
        return SyncDeadLetter.builder()
                .eventUuid(uuid)
                .gatewayEui("D1AAD1AAD1AAD1AA") // unique to this IT class (shared DB)
                .sourceNode("edge-dl-test")
                .op("GATEWAY_LOCATION_UPSERTED")
                .aggregateType("GATEWAY")
                .aggregateKey("D1AAD1AAD1AAD1AA")
                .payload(Map.of("contract_version", 1, "latitude", 46.5))
                .reason("integrity_violation")
                .reasonDetail("value too long for type character varying(36)")
                .contractVersion(1L)
                .receivedAt(Instant.now())
                .build();
    }

    @Test
    void roundTripsJsonbPayloadAndReason() {
        repository.saveAndFlush(row("dl-rt-1"));
        SyncDeadLetter got = repository.findAll().stream()
                .filter(d -> "dl-rt-1".equals(d.getEventUuid())).findFirst().orElseThrow();
        assertThat(got.getPayload()).containsEntry("latitude", 46.5);
        assertThat(got.getReason()).isEqualTo("integrity_violation");
        assertThat(got.getReceivedAt()).isNotNull();
    }

    @Test
    void eventUuidIsUniqueAndExistsCheckWorks() {
        repository.saveAndFlush(row("dl-uq-1"));
        assertThat(repository.existsByEventUuid("dl-uq-1")).isTrue();
        assertThat(repository.existsByEventUuid("dl-uq-never")).isFalse();
        assertThatThrownBy(() -> repository.saveAndFlush(row("dl-uq-1")))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void acceptsUuidsLongerThanTheInboxColumn() {
        // event_uuid is VARCHAR(64) (watermark last_event_uuid precedent) precisely so a
        // malformed >36-char uuid — unstorable in sync_inbox, hence dead-letter-worthy —
        // can itself be recorded. Task 4's poison repro depends on this.
        String longUuid = "dl-long-" + "x".repeat(32); // 40 chars
        repository.saveAndFlush(row(longUuid));
        assertThat(repository.existsByEventUuid(longUuid)).isTrue();
    }
}
```

Run: `./gradlew test --tests 'org.osi.server.sync.SyncDeadLetterRepositoryIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL — compile error (`SyncDeadLetter`/`SyncDeadLetterRepository` do not exist). That is this step's red.

- [ ] **Step 2.4: Implement the entity** — create `src/main/java/org/osi/server/sync/SyncDeadLetter.java` with exactly:

```java
package org.osi.server.sync;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.Map;

/**
 * Forensic record of a rejected sync event (spec §C): the payload the inbox dedup row
 * deliberately does not carry. Written alongside (never instead of) the inbox terminal
 * row — in the same transaction on in-method reject paths, in a fresh REQUIRES_NEW
 * transaction (recordRejection) for flush/commit-time permanent faults.
 */
@Entity
@Table(name = "sync_dead_letter")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SyncDeadLetter {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "event_uuid", nullable = false, length = 64, unique = true)
    private String eventUuid;

    @Column(name = "gateway_eui", nullable = false, length = 32)
    private String gatewayEui;

    @Column(name = "source_node", length = 100)
    private String sourceNode;

    @Column(name = "op", length = 50)
    private String op;

    @Column(name = "aggregate_type", length = 50)
    private String aggregateType;

    @Column(name = "aggregate_key", length = 100)
    private String aggregateKey;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "payload", columnDefinition = "jsonb")
    private Map<String, Object> payload;

    @Column(name = "reason", nullable = false, length = 50)
    private String reason;

    @Column(name = "reason_detail", columnDefinition = "TEXT")
    private String reasonDetail;

    @Column(name = "contract_version")
    private Long contractVersion;

    @Column(name = "occurred_at")
    private Instant occurredAt;

    @Column(name = "received_at", nullable = false)
    private Instant receivedAt;

    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt; // DB default now(); read-only mapping

    @PrePersist
    void prePersist() {
        if (receivedAt == null) receivedAt = Instant.now();
    }
}
```

- [ ] **Step 2.5: Implement the repository** — create `src/main/java/org/osi/server/sync/SyncDeadLetterRepository.java` with exactly:

```java
package org.osi.server.sync;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

public interface SyncDeadLetterRepository extends JpaRepository<SyncDeadLetter, Long> {

    /** Dedup pre-check (spec §C): a re-send of an already-dead-lettered event is a silent no-op. */
    boolean existsByEventUuid(String eventUuid);

    List<SyncDeadLetter> findByGatewayEuiOrderByReceivedAtDesc(String gatewayEui, Pageable pageable);

    List<SyncDeadLetter> findAllByOrderByReceivedAtDesc(Pageable pageable);

    long countByReceivedAtBefore(Instant cutoff);

    @Modifying
    @Transactional
    @Query("DELETE FROM SyncDeadLetter d WHERE d.receivedAt < :cutoff")
    int deleteByReceivedAtBefore(@Param("cutoff") Instant cutoff);
}
```

- [ ] **Step 2.6: Run it (green)**

Run: `./gradlew test --tests 'org.osi.server.sync.SyncDeadLetterRepositoryIT' --tests 'org.osi.server.testsupport.FlywayMigrationIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: all tests pass. (Hibernate `ddl-auto: validate` inside the slice also proves entity ↔ DDL agreement.)

- [ ] **Step 2.7: Commit**

```bash
git add src/main/resources/db/migration/V2026_07_07_001__sync_dead_letter.sql \
        src/main/java/org/osi/server/sync/SyncDeadLetter.java \
        src/main/java/org/osi/server/sync/SyncDeadLetterRepository.java \
        src/test/java/org/osi/server/sync/SyncDeadLetterRepositoryIT.java \
        src/test/java/org/osi/server/testsupport/FlywayMigrationIT.java
git commit -m "feat(sync): sync_dead_letter table + entity + repository (1.B4/DD13, closes the #89 residual)"
```

---

### Task 3: `SyncExceptionClassifier` — the loop-boundary classifier (spec §B), pure function

**Files:**
- Create: `src/test/java/org/osi/server/sync/SyncExceptionClassifierTest.java`
- Create: `src/main/java/org/osi/server/sync/SyncExceptionClassifier.java`

**Interfaces:**
- Produces: `SyncExceptionClassifier.isPermanent(Throwable) → boolean` consumed by Task 4's loop. PERMANENT ⇔ `DataIntegrityViolationException` or Hibernate `ConstraintViolationException` anywhere in the cause chain. Everything else — including the four named transient classes (`CannotAcquireLockException`, `QueryTimeoutException`, `DeadlockLoserDataAccessException`, any `TransientDataAccessException`), `UnexpectedRollbackException`, and unknowns — is RETRYABLE: never permanently drop an event on uncertainty.

- [ ] **Step 3.1: Write the failing test** — create `src/test/java/org/osi/server/sync/SyncExceptionClassifierTest.java` with exactly:

```java
package org.osi.server.sync;

import org.hibernate.exception.ConstraintViolationException;
import org.junit.jupiter.api.Test;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.transaction.UnexpectedRollbackException;

import java.sql.SQLException;

import static org.assertj.core.api.Assertions.assertThat;

class SyncExceptionClassifierTest {

    @Test
    void springDataIntegrityViolationIsPermanent() {
        assertThat(SyncExceptionClassifier.isPermanent(
                new DataIntegrityViolationException("value too long"))).isTrue();
    }

    @Test
    void hibernateConstraintViolationIsPermanent() {
        assertThat(SyncExceptionClassifier.isPermanent(
                new ConstraintViolationException("duplicate key", new SQLException("23505"), "ux_x"))).isTrue();
    }

    @Test
    void permanentCauseIsFoundAnywhereInTheChain() {
        Exception nested = new RuntimeException("outer",
                new IllegalStateException("mid",
                        new ConstraintViolationException("inner", new SQLException("23502"), "nn_x")));
        assertThat(SyncExceptionClassifier.isPermanent(nested)).isTrue();
    }

    @Test
    void namedTransientClassesAreRetryable() {
        assertThat(SyncExceptionClassifier.isPermanent(new CannotAcquireLockException("lock"))).isFalse();
        assertThat(SyncExceptionClassifier.isPermanent(new QueryTimeoutException("timeout"))).isFalse();
        assertThat(SyncExceptionClassifier.isPermanent(
                new DeadlockLoserDataAccessException("deadlock", new SQLException("40P01")))).isFalse();
    }

    @Test
    void unexpectedRollbackIsRetryable() {
        // A swallowed inner failure resurfacing at the proxy commit: cause unknown → conservative.
        assertThat(SyncExceptionClassifier.isPermanent(
                new UnexpectedRollbackException("tx silently rolled back"))).isFalse();
    }

    @Test
    void unknownExceptionsDefaultToRetryable() {
        assertThat(SyncExceptionClassifier.isPermanent(new RuntimeException("mystery"))).isFalse();
        assertThat(SyncExceptionClassifier.isPermanent(new NullPointerException())).isFalse();
        assertThat(SyncExceptionClassifier.isPermanent(null)).isFalse();
    }

    @Test
    void selfReferentialCauseChainDoesNotLoopForever() {
        RuntimeException a = new RuntimeException("a");
        RuntimeException b = new RuntimeException("b", a);
        a.initCause(b); // a -> b -> a cycle
        assertThat(SyncExceptionClassifier.isPermanent(b)).isFalse();
    }
}
```

- [ ] **Step 3.2: Run it (red)**

Run: `./gradlew test --tests 'org.osi.server.sync.SyncExceptionClassifierTest' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL — compile error, `SyncExceptionClassifier` does not exist.

- [ ] **Step 3.3: Implement** — create `src/main/java/org/osi/server/sync/SyncExceptionClassifier.java` with exactly:

```java
package org.osi.server.sync;

import org.springframework.dao.DataIntegrityViolationException;

/**
 * Loop-boundary exception classifier (spec §B). Under REQUIRES_NEW the per-event commit
 * fires at the proxy boundary as applyOne returns — after any in-method try/catch — so
 * flush/commit-time faults surface in applyEventsV2's loop, which uses this classifier.
 *
 * PERMANENT means the event's own data violates the mirror schema and will fail
 * identically on every retry: dead-letter immediately (reason=integrity_violation).
 * Everything else is RETRYABLE — including the transient DataAccess family
 * (CannotAcquireLockException, QueryTimeoutException, DeadlockLoserDataAccessException),
 * UnexpectedRollbackException, and anything unrecognized: never permanently drop an
 * event on uncertainty. A misclassified fault loops visibly (the edge re-sends every
 * 30 s); the remedy is a one-line extension here, not attempt-counting machinery.
 */
final class SyncExceptionClassifier {

    private static final int MAX_CAUSE_DEPTH = 20; // guards against cause cycles

    private SyncExceptionClassifier() {
    }

    static boolean isPermanent(Throwable ex) {
        Throwable t = ex;
        for (int depth = 0; t != null && depth < MAX_CAUSE_DEPTH; depth++) {
            if (t instanceof DataIntegrityViolationException) return true;
            if (t instanceof org.hibernate.exception.ConstraintViolationException) return true;
            t = t.getCause() == t ? null : t.getCause();
        }
        return false;
    }
}
```

- [ ] **Step 3.4: Run it (green)**

Run: `./gradlew test --tests 'org.osi.server.sync.SyncExceptionClassifierTest' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: 7 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/main/java/org/osi/server/sync/SyncExceptionClassifier.java \
        src/test/java/org/osi/server/sync/SyncExceptionClassifierTest.java
git commit -m "feat(sync): loop-boundary exception classifier — permanent integrity faults vs retryable (1.B4 spec B)"
```

---

### Task 4: `SyncEventTxExecutor` + non-transactional `applyEventsV2` — TDD'd by the poison-batch repro

This is the core task. The poison-batch IT is written FIRST against the NEW expected behavior; it is red against today's code (today: the whole batch rolls back and the request throws), then the executor + rewrite make it green.

**Files:**
- Create: `src/test/java/org/osi/server/sync/PoisonBatchIT.java`
- Create: `src/main/java/org/osi/server/sync/SyncEventShapes.java`
- Create: `src/main/java/org/osi/server/sync/SyncEventTxExecutor.java`
- Modify: `src/main/java/org/osi/server/sync/EdgeSyncService.java`

**Interfaces:**
- `SyncEventTxExecutor.applyOne(gatewayEui, sourceNode, event, dispatcher)` — `REQUIRES_NEW`; today's `applyEventV2` semantics + dead-letter rows on reject paths + terminal `entityManager.flush()`; **no blanket `catch (Exception)`** (repository/JPA faults propagate to the loop). `recordRejection(...)` — `REQUIRES_NEW`; dead-letter + inbox rows in a fresh tx. `finalizeBatch(...)` — `@Transactional`; cursor + last-seen.
- `SyncOpDispatcher` (nested interface) — the op dispatch stays in `EdgeSyncService` (its private `applyEvent` + ~40 upsert helpers do not move); `applyEventsV2` passes a per-batch anonymous implementation. This avoids a circular `EdgeSyncService ↔ executor` bean dependency and is the seam DD12's appliers later replace.
- `SyncEventShapes` — static pure helpers (`payloadWithOp`, `eventSyncVersion`, `eventContractVersion`, `parseInstantOrNull`) moved out of `EdgeSyncService` so the executor needs no service reference; contains small deliberate copies of the private `str`/`nullableStr`/`numLong` helpers (which stay in `EdgeSyncService` for its ~100 other call sites).
- **Poison mechanics (deterministic, domain-independent):** an event with a 40-char `eventUuid` passes every in-method step, then the deferred INSERT into `sync_inbox.event_uuid VARCHAR(36)` (verified: `V17__bidirectional_sync_foundation.sql:94`) fails at the executor's explicit flush — the exact flush-time surface the spec names. Its dead-letter row fits (`VARCHAR(64)`, Task 2); its inbox row is skipped (uuid cannot fit — `recordRejection` guards on length; dedup for it rides on `sync_dead_letter`).
- **Test op:** `GATEWAY_LOCATION_UPSERTED` — real repository path (`gateway_locations`, PK = gateway EUI, no FK on devices), minimal payload, no domain seeding needed.

- [ ] **Step 4.1: Write the failing poison-batch IT** — create `src/test/java/org/osi/server/sync/PoisonBatchIT.java` with exactly:

```java
package org.osi.server.sync;

import org.junit.jupiter.api.Test;
import org.osi.server.analytics.ZoneEnvironmentService;
import org.osi.server.command.CommandLeaseService;
import org.osi.server.command.CommandService;
import org.osi.server.device.DeviceService;
import org.osi.server.gateway.GatewayLocationRepository;
import org.osi.server.security.EdgeOwnershipService;
import org.osi.server.soil.ZoneSoilProfileService;
import org.osi.server.testsupport.PostgresSyncTestBase;
import org.osi.server.user.LinkedGatewayAccountService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;

/**
 * DD15 poison-batch reproduction (spec §G). Asserts the NEW per-event-transaction
 * behavior: events 1..k-1 commit, the poison k is dead-lettered (permanent class) or
 * left unpersisted (transient class), k+1..n apply. Against the pre-fix code this
 * test fails because the shared batch transaction rolls everything back.
 *
 * NOT test-transactional (NOT_SUPPORTED): the executor's real REQUIRES_NEW commits are
 * the unit under test. The DB is shared across IT classes — all identifiers here are
 * unique to this class (gateway EUI 10AA..., uuid prefix pb-).
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
@Import({EdgeSyncService.class, SyncEventTxExecutor.class, SyncPayloadCanonicalizer.class})
class PoisonBatchIT extends PostgresSyncTestBase {

    private static final String GW = "10AA10AA10AA10AA";

    @Autowired private EdgeSyncService edgeSyncService;
    @Autowired private SyncInboxRepository inboxRepository;
    @Autowired private SyncDeadLetterRepository deadLetterRepository;
    @Autowired private SyncResourceWatermarkRepository watermarkRepository;
    @Autowired private GatewayLocationRepository gatewayLocationRepository;

    @MockBean private DeviceService deviceService;
    @MockBean private CommandService commandService;
    @MockBean private CommandLeaseService commandLeaseService;
    @MockBean private ZoneSoilProfileService zoneSoilProfileService;
    @MockBean private ZoneEnvironmentService zoneEnvironmentService;
    @MockBean private LinkedGatewayAccountService linkedGatewayAccountService;
    @MockBean private EdgeOwnershipService ownershipService;

    private static EdgeSyncService.SyncEventRecord gwLocEvent(String uuid, long syncVersion) {
        return new EdgeSyncService.SyncEventRecord(
                uuid, "GATEWAY", GW, "GATEWAY_LOCATION_UPSERTED", syncVersion,
                "2026-07-07T10:00:00Z",
                Map.of("contract_version", "1",
                        "gateway_device_eui", GW,
                        "latitude", 46.5 + syncVersion,
                        "longitude", 7.1,
                        "sync_version", String.valueOf(syncVersion)));
    }

    @Test
    void poisonAtKCommitsPriorEventsDeadLettersKAndAppliesTheRest() {
        // k=3 carries a 40-char eventUuid: every in-method step succeeds, then the
        // deferred INSERT into sync_inbox.event_uuid VARCHAR(36) blows up at the
        // executor's explicit flush — the flush-time poison class the spec names.
        String poisonUuid = "pb-poison-" + "x".repeat(30); // 40 chars
        List<EdgeSyncService.SyncEventRecord> events = List.of(
                gwLocEvent("pb-evt-1", 1),
                gwLocEvent("pb-evt-2", 2),
                gwLocEvent(poisonUuid, 3),
                gwLocEvent("pb-evt-4", 4),
                gwLocEvent("pb-evt-5", 5));

        SyncEventBatchResponse response = edgeSyncService.applyEventsV2(
                new EdgeSyncService.EdgeEventBatchRequest("edge-pb", GW, events));

        assertThat(response.results()).extracting(SyncEventResult::getStatus).containsExactly(
                SyncEventResult.Status.APPLIED,
                SyncEventResult.Status.APPLIED,
                SyncEventResult.Status.REJECTED,
                SyncEventResult.Status.APPLIED,
                SyncEventResult.Status.APPLIED);
        assertThat(response.results().get(2).getReason()).isEqualTo("integrity_violation");

        // 1..k-1 and k+1..n committed for real (each in its own REQUIRES_NEW tx)
        for (String uuid : List.of("pb-evt-1", "pb-evt-2", "pb-evt-4", "pb-evt-5")) {
            assertThat(inboxRepository.existsById(uuid)).as(uuid).isTrue();
        }
        assertThat(gatewayLocationRepository.findById(GW)).isPresent();
        assertThat(watermarkRepository.find(GW, "GATEWAY", GW).orElseThrow()
                .getHighestSyncVersion()).isEqualTo(5L);

        // k: dead-lettered via recordRejection's fresh transaction, with payload intact.
        SyncDeadLetter dead = deadLetterRepository.findAll().stream()
                .filter(d -> poisonUuid.equals(d.getEventUuid())).findFirst().orElseThrow();
        assertThat(dead.getReason()).isEqualTo("integrity_violation");
        assertThat(dead.getGatewayEui()).isEqualTo(GW);
        assertThat(dead.getPayload()).containsEntry("gateway_device_eui", GW);
        // Its >36-char uuid cannot live in the inbox; dedup rides on sync_dead_letter.
        assertThat(inboxRepository.existsById(poisonUuid)).isFalse();
    }

    @Test
    void transientFaultIsRetryableAndPersistsNothingForThatEvent() {
        // First ownership check throws a transient lock failure (propagates: applyOne only
        // catches OwnershipDeniedException there), subsequent calls pass.
        doThrow(new CannotAcquireLockException("lock timeout (test)"))
                .doNothing()
                .when(ownershipService).requireMutate(anyString(), anyString(), anyString());

        List<EdgeSyncService.SyncEventRecord> events = List.of(
                gwLocEvent("pb-t-1", 11),
                gwLocEvent("pb-t-2", 12),
                gwLocEvent("pb-t-3", 13));

        SyncEventBatchResponse response = edgeSyncService.applyEventsV2(
                new EdgeSyncService.EdgeEventBatchRequest("edge-pb-t", GW, events));

        assertThat(response.results()).extracting(SyncEventResult::getStatus).containsExactly(
                SyncEventResult.Status.RETRYABLE_ERROR,
                SyncEventResult.Status.APPLIED,
                SyncEventResult.Status.APPLIED);
        // Nothing persisted for the transient event: re-sendable without tripping dedup.
        assertThat(inboxRepository.existsById("pb-t-1")).isFalse();
        assertThat(deadLetterRepository.existsByEventUuid("pb-t-1")).isFalse();

        // A later re-send applies cleanly. (Note: re-sending it verbatim at its ORIGINAL
        // syncVersion 11 would now be stale_sync_version — successors 12/13 already
        // applied to the same GATEWAY watermark slot. Inherent watermark semantics,
        // benign for last-writer-wins upserts; append-only telemetry has per-row
        // watermark slots and never collides. Documented in the PR body.)
        SyncEventBatchResponse retry = edgeSyncService.applyEventsV2(
                new EdgeSyncService.EdgeEventBatchRequest("edge-pb-t", GW,
                        List.of(gwLocEvent("pb-t-1", 14))));
        assertThat(retry.results().get(0).getStatus()).isEqualTo(SyncEventResult.Status.APPLIED);
    }
}
```

- [ ] **Step 4.2: Run it (red — this is the bug demonstration)**

Run: `./gradlew test --tests 'org.osi.server.sync.PoisonBatchIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL — compile error (`SyncEventTxExecutor` does not exist). This is the TDD red: the test encodes the NEW behavior. (The pre-fix bug itself — whole-batch rollback — is what this test would show if pointed at today's `applyEventsV2`: the request throws at commit and no inbox rows survive; that demonstration is documented in the spec §G step 2 and does not need to be kept as a permanent failing artifact.)

- [ ] **Step 4.3: Implement `SyncEventShapes`** — create `src/main/java/org/osi/server/sync/SyncEventShapes.java` with exactly:

```java
package org.osi.server.sync;

import lombok.extern.slf4j.Slf4j;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure, static event-shape helpers shared by EdgeSyncService and SyncEventTxExecutor.
 * The private str/nullableStr/numLong copies here are deliberate small duplicates of
 * EdgeSyncService's instance helpers (which stay for its ~100 other call sites): the
 * alternative is a circular EdgeSyncService <-> executor bean dependency.
 */
@Slf4j
final class SyncEventShapes {

    static final long SYNC_EVENT_CONTRACT_VERSION = 1L;

    private SyncEventShapes() {
    }

    static Map<String, Object> payloadWithOp(EdgeSyncService.SyncEventRecord event) {
        var payload = new HashMap<>(event.payload());
        payload.put("op", event.op());
        payload.putIfAbsent("event_uuid", event.eventUuid());
        payload.putIfAbsent("eventUuid", event.eventUuid());
        payload.putIfAbsent("aggregate_key", event.aggregateKey());
        payload.putIfAbsent("aggregateKey", event.aggregateKey());
        return payload;
    }

    static long eventSyncVersion(EdgeSyncService.SyncEventRecord event) {
        if (event.syncVersion() != null) {
            return event.syncVersion();
        }
        return numLong(event.payload(), "sync_version", "syncVersion", 0L);
    }

    static Long eventContractVersion(EdgeSyncService.SyncEventRecord event) {
        String value = nullableStr(event.payload(), "contract_version", "contractVersion");
        if (value == null) {
            return null;
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException e) {
            log.warn("Ignoring invalid sync event contract_version value '{}' on event {}",
                    value, event.eventUuid());
            return null;
        }
    }

    static Instant parseInstantOrNull(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            return Instant.parse(value);
        } catch (Exception e) {
            return null;
        }
    }

    private static String str(Map<String, Object> payload, String... keys) {
        for (String key : keys) {
            Object value = payload.get(key);
            if (value != null) return String.valueOf(value);
        }
        return null;
    }

    private static String nullableStr(Map<String, Object> payload, String... keys) {
        String value = str(payload, keys);
        return value == null || value.isBlank() ? null : value;
    }

    private static long numLong(Map<String, Object> payload, String key, String altKey, long defaultValue) {
        for (String k : List.of(key, altKey)) {
            Object value = payload.get(k);
            if (value != null) return Long.parseLong(String.valueOf(value));
        }
        return defaultValue;
    }
}
```

- [ ] **Step 4.4: Implement the executor** — create `src/main/java/org/osi/server/sync/SyncEventTxExecutor.java` with exactly:

```java
package org.osi.server.sync;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.osi.server.device.DeviceRepository;
import org.osi.server.security.EdgeOwnershipService;
import org.osi.server.security.OwnershipDeniedException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/**
 * Per-event transaction boundary for sync ingest (spec §A). One event = one
 * REQUIRES_NEW transaction: a poison event can no longer mark a batch-wide
 * transaction rollback-only and destroy the work of its neighbours.
 *
 * Body of applyOne = the former EdgeSyncService#applyEventV2, moved (not rewritten),
 * minus the blanket catch(Exception) — a repository/JPA-originated fault has already
 * marked THIS transaction rollback-only; swallowing it would only resurface as
 * UnexpectedRollbackException at the proxy commit. Such faults propagate to
 * applyEventsV2's loop, the only scope that outlives this method's commit.
 *
 * DD12 note: when per-resource appliers are extracted later, they replace the
 * SyncOpDispatcher implementation — this boundary does not change.
 */
@Component
@RequiredArgsConstructor
@Slf4j
class SyncEventTxExecutor {

    /** sync_inbox.event_uuid is VARCHAR(36) (V17); longer uuids cannot be inbox-deduped. */
    static final int INBOX_UUID_MAX = 36;

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private final SyncInboxRepository inboxRepository;
    private final SyncResourceWatermarkRepository watermarkRepository;
    private final SyncDeadLetterRepository deadLetterRepository;
    private final SyncCursorRepository cursorRepository;
    private final DeviceRepository deviceRepository;
    private final EdgeOwnershipService ownershipService;
    private final SyncPayloadCanonicalizer syncPayloadCanonicalizer;

    @PersistenceContext
    private EntityManager entityManager;

    /** Op dispatch stays in EdgeSyncService (with its upsert helpers); passed per batch. */
    interface SyncOpDispatcher {
        boolean supports(EdgeSyncService.SyncEventRecord event);

        void apply(EdgeSyncService.SyncEventRecord event);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public SyncEventResult applyOne(String gatewayDeviceEui, String sourceNode,
                                    EdgeSyncService.SyncEventRecord event, SyncOpDispatcher dispatcher) {
        if (event.eventUuid() == null || event.eventUuid().isBlank()) {
            // Unreachable from a well-formed edge (sync_outbox.event_uuid is its PK).
            // No dead-letter row: sync_dead_letter.event_uuid is NOT NULL by design.
            return SyncEventResult.rejected(null, "missing_event_uuid");
        }
        if (inboxRepository.existsById(event.eventUuid())) {
            return SyncEventResult.duplicate(event.eventUuid());
        }

        Long contractVersion = SyncEventShapes.eventContractVersion(event);
        if (contractVersion == null) {
            log.debug("Sync event {} op={} has no contract_version; treating as legacy",
                    event.eventUuid(), event.op());
        } else if (contractVersion != SyncEventShapes.SYNC_EVENT_CONTRACT_VERSION) {
            log.warn("Sync event {} op={} has unexpected contract_version={}; applying with current handler {}",
                    event.eventUuid(), event.op(), contractVersion, SyncEventShapes.SYNC_EVENT_CONTRACT_VERSION);
        }

        if (!dispatcher.supports(event)) {
            saveInboxTerminal(event, sourceNode);
            saveDeadLetter(gatewayDeviceEui, sourceNode, event, "unknown_op", null);
            log.warn("Rejecting unsupported sync event {} op={} contractVersion={} before ownership/watermark checks",
                    event.eventUuid(), event.op(), contractVersion);
            return SyncEventResult.rejected(event.eventUuid(), "unknown_op");
        }

        EdgeSyncService.EventResourceRef resource = EdgeSyncService.EventResourceRef.from(event);
        long incomingSyncVersion = SyncEventShapes.eventSyncVersion(event);

        try {
            ownershipService.requireMutate(gatewayDeviceEui, resource.resourceType(), resource.resourceId());
        } catch (OwnershipDeniedException e) {
            // Thrown by requireMutate's own frames, not from inside a repository proxy —
            // the transaction is still healthy, terminal rows commit with it (spec §A surface 1).
            saveInboxTerminal(event, sourceNode);
            saveDeadLetter(gatewayDeviceEui, sourceNode, event, "ownership_denied", e.getMessage());
            return SyncEventResult.rejected(event.eventUuid(), "ownership_denied: " + e.getMessage());
        }
        String payloadHash = syncPayloadCanonicalizer.hash(
                OBJECT_MAPPER.valueToTree(SyncEventShapes.payloadWithOp(event)));

        Optional<SyncResourceWatermark> existing = watermarkRepository.find(
                gatewayDeviceEui, resource.resourceType(), resource.resourceId());
        if (existing.isPresent()) {
            SyncResourceWatermark watermark = existing.get();
            long highest = Optional.ofNullable(watermark.getHighestSyncVersion()).orElse(0L);
            if (highest > incomingSyncVersion) {
                saveInboxTerminal(event, sourceNode);
                saveDeadLetter(gatewayDeviceEui, sourceNode, event, "stale_sync_version",
                        "highest=" + highest + " incoming=" + incomingSyncVersion);
                return SyncEventResult.rejected(event.eventUuid(), "stale_sync_version");
            }
            if (highest == incomingSyncVersion) {
                if (Objects.equals(watermark.getPayloadHash(), payloadHash)) {
                    saveInboxTerminal(event, sourceNode);
                    return SyncEventResult.duplicate(event.eventUuid());
                }
                saveInboxTerminal(event, sourceNode);
                saveDeadLetter(gatewayDeviceEui, sourceNode, event, "equal_version_payload_conflict",
                        "watermarkHash=" + watermark.getPayloadHash() + " incomingHash=" + payloadHash);
                return SyncEventResult.rejected(event.eventUuid(), "equal_version_payload_conflict");
            }
        }

        try {
            dispatcher.apply(event);
        } catch (IllegalArgumentException e) {
            // Validation thrown by EdgeSyncService's own frames (e.g. "Zone not found") —
            // transaction still healthy; terminal rows commit with it (spec §A surface 1).
            saveInboxTerminal(event, sourceNode);
            saveDeadLetter(gatewayDeviceEui, sourceNode, event, "invalid_payload", e.getMessage());
            log.warn("Rejecting sync event {} op={} key={} due to {}",
                    event.eventUuid(), event.op(), event.aggregateKey(), e.getMessage());
            return SyncEventResult.rejected(event.eventUuid(), e.getMessage());
        }
        // Deliberately NO catch (Exception) from here on (spec §A surface 2).
        watermarkRepository.upsert(SyncResourceWatermark.of(
                gatewayDeviceEui, resource.resourceType(), resource.resourceId(),
                incomingSyncVersion, event.eventUuid(), payloadHash));
        saveInboxTerminal(event, sourceNode);
        // Surface Hibernate's deferred constraint checks inside the per-event scope
        // instead of at the proxy-boundary commit (spec §A).
        entityManager.flush();
        return SyncEventResult.applied(event.eventUuid(), resource.resourceType(),
                resource.resourceId(), incomingSyncVersion);
    }

    /**
     * Terminal bookkeeping for an event whose own transaction already rolled back
     * (flush/commit-time permanent fault): dead-letter + inbox rows in a FRESH
     * transaction — the only way that event gets both rows (spec §A). Invoked from
     * applyEventsV2's loop through the bean proxy, never in-bean (self-invocation trap).
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordRejection(String gatewayDeviceEui, String sourceNode,
                                EdgeSyncService.SyncEventRecord event, String reason, String detail) {
        saveDeadLetter(gatewayDeviceEui, sourceNode, event, reason, detail);
        String uuid = event.eventUuid();
        if (uuid != null && !uuid.isBlank() && uuid.length() <= INBOX_UUID_MAX
                && !inboxRepository.existsById(uuid)) {
            inboxRepository.save(SyncInboxEvent.builder()
                    .eventUuid(uuid)
                    .sourceNode(sourceNode)
                    .build());
        }
        // uuid longer than the inbox column: dedup rides on sync_dead_letter (VARCHAR(64))
        // via saveDeadLetter's existsByEventUuid pre-check.
    }

    /**
     * Batch bookkeeping (spec §A): cursor + gateway last-seen, one small transaction
     * called once after the loop. applyEventsV2 itself is deliberately NOT transactional
     * (REQUIRES_NEW-under-outer-tx double-checks-out Hikari connections; idle-in-tx
     * session across up to 100 inner commits).
     */
    @Transactional
    public void finalizeBatch(String sourceNode, String gatewayDeviceEui,
                              Instant lastEventAt, String lastEventUuid) {
        cursorRepository.save(SyncCursor.builder()
                .peerNode(sourceNode)
                .lastEventAt(lastEventAt)
                .lastEventUuid(lastEventUuid)
                .build());
        touchGatewayLastSeen(gatewayDeviceEui);
    }

    // Small deliberate duplicate of EdgeSyncService#touchGatewayLastSeen (which stays for
    // the V1/bootstrap/pending-commands call sites) — avoids a circular bean dependency.
    private void touchGatewayLastSeen(String gatewayDeviceEui) {
        if (gatewayDeviceEui == null || gatewayDeviceEui.isBlank()) {
            return;
        }
        String normalized = gatewayDeviceEui.trim().toUpperCase();
        deviceRepository.findByDeviceEui(normalized).ifPresent(gateway -> {
            gateway.setLastSeen(Instant.now());
            if (gateway.getGatewayDeviceEui() == null || gateway.getGatewayDeviceEui().isBlank()) {
                gateway.setGatewayDeviceEui(normalized);
            }
            deviceRepository.save(gateway);
        });
    }

    private void saveInboxTerminal(EdgeSyncService.SyncEventRecord event, String sourceNode) {
        inboxRepository.save(SyncInboxEvent.builder()
                .eventUuid(event.eventUuid())
                .sourceNode(sourceNode)
                .build());
    }

    private void saveDeadLetter(String gatewayDeviceEui, String sourceNode,
                                EdgeSyncService.SyncEventRecord event, String reason, String detail) {
        String uuid = event.eventUuid();
        if (uuid == null || uuid.isBlank()) {
            return; // sync_dead_letter.event_uuid is NOT NULL; nothing identifiable to store
        }
        if (deadLetterRepository.existsByEventUuid(uuid)) {
            return; // re-send of an already-dead-lettered event: silent no-op (spec §C)
        }
        deadLetterRepository.save(SyncDeadLetter.builder()
                .eventUuid(uuid)
                .gatewayEui(gatewayDeviceEui == null || gatewayDeviceEui.isBlank() ? "UNKNOWN" : gatewayDeviceEui)
                .sourceNode(sourceNode)
                .op(event.op())
                .aggregateType(event.aggregateType())
                .aggregateKey(event.aggregateKey())
                .payload(event.payload())
                .reason(reason)
                .reasonDetail(detail)
                .contractVersion(SyncEventShapes.eventContractVersion(event))
                .occurredAt(SyncEventShapes.parseInstantOrNull(event.occurredAt()))
                .receivedAt(Instant.now())
                .build());
    }
}
```

- [ ] **Step 4.5: Rewire `EdgeSyncService`** — apply exactly these modifications to `src/main/java/org/osi/server/sync/EdgeSyncService.java`:

**(a)** Add the executor to the dependency list — after the line `private final ApplicationEventPublisher eventPublisher;` add:

```java
    private final SyncEventTxExecutor syncEventTxExecutor;
```

**(b)** Delete the now-moved constant `private static final long SYNC_EVENT_CONTRACT_VERSION = 1L;` (it lives in `SyncEventShapes`).

**(c)** Replace the entire `applyEventsV2` method (currently `@Transactional`, lines ~212–235) AND delete the entire private `applyEventV2` method (~237–319) AND the private `saveInboxTerminal` method (~321–326), with:

```java
    public SyncEventBatchResponse applyEventsV2(EdgeEventBatchRequest request) {
        // Deliberately NOT @Transactional (spec §A): an outer transaction would hold one
        // Hikari connection for the whole batch while every REQUIRES_NEW applyOne suspends
        // it and checks out a second (no pool config in this repo — default max 10; ~5
        // concurrent unjittered 30 s batch POSTs could starve the pool), and would sit
        // idle-in-transaction across up to 100 inner commits. Cursor + last-seen commit
        // in finalizeBatch instead.
        List<SyncEventResult> results = new ArrayList<>();
        Instant lastEventAt = null;
        String lastEventUuid = null;
        String normalizedGatewayDeviceEui = normalizeGatewayDeviceEui(request.gatewayDeviceEui());
        SyncEventTxExecutor.SyncOpDispatcher dispatcher = new SyncEventTxExecutor.SyncOpDispatcher() {
            @Override
            public boolean supports(SyncEventRecord event) {
                return applyEvent(normalizedGatewayDeviceEui, event, true);
            }

            @Override
            public void apply(SyncEventRecord event) {
                applyEvent(normalizedGatewayDeviceEui, event);
            }
        };

        for (SyncEventRecord event : request.events()) {
            SyncEventResult result;
            try {
                result = syncEventTxExecutor.applyOne(
                        normalizedGatewayDeviceEui, request.sourceNode(), event, dispatcher);
            } catch (Exception ex) {
                // The loop is where flush-time and commit-time exceptions surface: under
                // REQUIRES_NEW the commit fires at the proxy boundary as applyOne returns,
                // after its in-method try/catch has gone out of scope (spec §A surface 2).
                result = classifyLoopFailure(normalizedGatewayDeviceEui, request.sourceNode(), event, ex);
            }
            results.add(result);
            if (result.getStatus() == SyncEventResult.Status.APPLIED && event.occurredAt() != null) {
                lastEventAt = parseInstant(event.occurredAt());
                lastEventUuid = event.eventUuid();
            }
        }

        syncEventTxExecutor.finalizeBatch(
                request.sourceNode(), normalizedGatewayDeviceEui, lastEventAt, lastEventUuid);
        return new SyncEventBatchResponse(results);
    }

    private SyncEventResult classifyLoopFailure(String gatewayDeviceEui, String sourceNode,
                                                SyncEventRecord event, Exception ex) {
        if (SyncExceptionClassifier.isPermanent(ex)) {
            log.warn("Dead-lettering sync event {} op={} key={} as integrity_violation: {}",
                    event.eventUuid(), event.op(), event.aggregateKey(), ex.getMessage());
            try {
                syncEventTxExecutor.recordRejection(gatewayDeviceEui, sourceNode, event,
                        "integrity_violation", ex.getMessage());
            } catch (Exception recordFailure) {
                // Last resort: if the rejection cannot be recorded, tell the edge to retry —
                // never silently drop (spec §B conservative default).
                log.error("Failed to record rejection for sync event {}: {}",
                        event.eventUuid(), recordFailure.getMessage());
                return SyncEventResult.retryable(event.eventUuid(), ex.getMessage());
            }
            return SyncEventResult.rejected(event.eventUuid(), "integrity_violation");
        }
        log.warn("Retryable sync event failure {} op={} key={} due to {}",
                event.eventUuid(), event.op(), event.aggregateKey(), ex.getMessage());
        return SyncEventResult.retryable(event.eventUuid(), ex.getMessage());
    }
```

**(d)** Make the resource-ref record reachable by the executor (same package) — change:

```java
    private record EventResourceRef(String resourceType, String resourceId) {
        private static EventResourceRef from(SyncEventRecord event) {
```

to:

```java
    record EventResourceRef(String resourceType, String resourceId) {
        static EventResourceRef from(SyncEventRecord event) {
```

(The record's other nested static helpers stay `private` — they are only called from within the record.)

**(e)** Update the one remaining `payloadWithOp` call site inside the private `applyEvent(...)` (line ~430: `Map<String, Object> payload = dryRun ? null : payloadWithOp(event);`) to:

```java
        Map<String, Object> payload = dryRun ? null : SyncEventShapes.payloadWithOp(event);
```

then delete the now-unused private methods `payloadWithOp`, `eventSyncVersion`, and `eventContractVersion` (moved to `SyncEventShapes`).

**(f)** Do NOT touch `applyEvents` (V1), `applyBootstrap`, `touchGatewayLastSeen`, or anything else.

- [ ] **Step 4.6: Run the repro (green) + the whole existing suite**

Run: `./gradlew test --tests 'org.osi.server.sync.PoisonBatchIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: both tests PASS — events 1..k-1 and k+1..n committed, poison dead-lettered with `reason=integrity_violation`, transient variant retryable with nothing persisted.

Then run the full suite to prove no regression in the 159 existing test files (compile changes touched `EdgeSyncService`):
Run: `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: BUILD SUCCESSFUL. If any existing Mockito test constructed `EdgeSyncService` directly and now misses the executor constructor arg, add a `@Mock SyncEventTxExecutor` to it — the only legitimate adaptation; do not weaken assertions.

- [ ] **Step 4.7: Commit**

```bash
git add src/main/java/org/osi/server/sync/SyncEventShapes.java \
        src/main/java/org/osi/server/sync/SyncEventTxExecutor.java \
        src/main/java/org/osi/server/sync/EdgeSyncService.java \
        src/test/java/org/osi/server/sync/PoisonBatchIT.java
git commit -m "feat(sync): per-event REQUIRES_NEW boundary + loop classifier + recordRejection — defuses the poison-pill batch (1.B4 spec A/B)"
```

---

### Task 5: Retention job + DbHealthCounters + admin list endpoint

**Files:**
- Create: `src/test/java/org/osi/server/retention/SyncDeadLetterRetentionJobTest.java`
- Create: `src/main/java/org/osi/server/retention/SyncDeadLetterRetentionJob.java`
- Modify: `src/main/java/org/osi/server/retention/DbHealthCounters.java`
- Create: `src/main/java/org/osi/server/sync/SyncDeadLetterResponse.java`
- Create: `src/main/java/org/osi/server/sync/SyncDeadLetterAdminController.java`
- Create: `src/test/java/org/osi/server/sync/SyncDeadLetterAdminControllerTest.java`

**Interfaces:**
- Retention: 90-day default (`osi.retention.sync-dead-letter.days`), `SyncInboxRetentionJob` shape verbatim (Java-side `@Value` default, no `application.yml` entry — house pattern). 90 not 365: dead-letters are a triage surface, not a replay-dedup ledger (spec §C).
- Counter key `sync_dead_letter_total` via the `DbHealthCounters` allowlist (the spec's `dead_letter_total`, following the existing `<table>_total` key convention — one-word naming delta, report upward).
- Admin: `GET /api/v1/admin/sync-dead-letters?gatewayEui=&limit=` — read-only, no requeue (spec §D YAGNI), `SyncHealthController` precedent (`@PreAuthorize` ADMIN/SUPER_ADMIN, limit bounded [1,500]).

- [ ] **Step 5.1: Write the failing retention test** — create `src/test/java/org/osi/server/retention/SyncDeadLetterRetentionJobTest.java` with exactly:

```java
package org.osi.server.retention;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.osi.server.sync.SyncDeadLetterRepository;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SyncDeadLetterRetentionJobTest {

    @Mock
    private SyncDeadLetterRepository repository;

    @InjectMocks
    private SyncDeadLetterRetentionJob job;

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(job, "retentionDays", 90);
    }

    @Test
    void dryRunReportsCandidatesWithoutDeleting() {
        when(repository.countByReceivedAtBefore(any(Instant.class))).thenReturn(4L);

        SyncDeadLetterRetentionJob.Report report = job.run(true);

        assertThat(report.candidateCount()).isEqualTo(4L);
        assertThat(report.deletedCount()).isZero();
        assertThat(report.dryRun()).isTrue();
        verify(repository, never()).deleteByReceivedAtBefore(any(Instant.class));
    }

    @Test
    void liveRunDeletesOldRows() {
        when(repository.countByReceivedAtBefore(any(Instant.class))).thenReturn(4L);
        when(repository.deleteByReceivedAtBefore(any(Instant.class))).thenReturn(4);

        SyncDeadLetterRetentionJob.Report report = job.run(false);

        assertThat(report.candidateCount()).isEqualTo(4L);
        assertThat(report.deletedCount()).isEqualTo(4L);
        assertThat(report.dryRun()).isFalse();
    }
}
```

- [ ] **Step 5.2: Run it (red)** — `./gradlew test --tests 'org.osi.server.retention.SyncDeadLetterRetentionJobTest' -x buildFrontend -x buildTerraIntelligenceFrontend` → FAIL (compile: class missing).

- [ ] **Step 5.3: Implement the job** — create `src/main/java/org/osi/server/retention/SyncDeadLetterRetentionJob.java` with exactly:

```java
package org.osi.server.retention;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.osi.server.sync.SyncDeadLetterRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;

@Component
@RequiredArgsConstructor
@Slf4j
public class SyncDeadLetterRetentionJob {

    private final SyncDeadLetterRepository repository;

    // 90 days (spec §C): the dead-letter table is a triage surface for a slowly,
    // unevenly upgrading fleet — not a replay-dedup ledger like sync_inbox (365 d).
    // Generous on purpose: pruning too early re-loses the forensic value (#89);
    // tighten only after the admin surface has been used in anger.
    @Value("${osi.retention.sync-dead-letter.days:90}")
    private int retentionDays;

    public record Report(long candidateCount, long deletedCount, Instant cutoff, boolean dryRun) {}

    @Scheduled(cron = "${osi.retention.sync-dead-letter.cron:0 45 3 * * *}")
    @Transactional
    public Report runScheduled() {
        return run(false);
    }

    @Transactional
    public Report run(boolean dryRun) {
        Instant cutoff = Instant.now().minus(Duration.ofDays(Math.max(1, retentionDays)));
        long candidates = repository.countByReceivedAtBefore(cutoff);
        if (dryRun) {
            return new Report(candidates, 0, cutoff, true);
        }

        int deleted = repository.deleteByReceivedAtBefore(cutoff);
        if (deleted > 0) {
            log.info("Purged {} sync_dead_letter rows older than {} days", deleted, retentionDays);
        }
        return new Report(candidates, deleted, cutoff, false);
    }
}
```

Run: `./gradlew test --tests 'org.osi.server.retention.SyncDeadLetterRetentionJobTest' -x buildFrontend -x buildTerraIntelligenceFrontend` → PASS.

- [ ] **Step 5.4: DbHealthCounters** — in `src/main/java/org/osi/server/retention/DbHealthCounters.java`, add `"sync_dead_letter",` to `ALLOWED_COUNT_SOURCES` (after `"sync_outbox",`) and add this line in `snapshot()` after the `sync_outbox_pending` count:

```java
        count(counters, "sync_dead_letter_total", "sync_dead_letter");
```

- [ ] **Step 5.5: DTO + admin controller** — create `src/main/java/org/osi/server/sync/SyncDeadLetterResponse.java` with exactly:

```java
package org.osi.server.sync;

import java.time.Instant;
import java.util.Map;

/** Wire DTO for the read-only dead-letter admin listing (never the entity directly). */
public record SyncDeadLetterResponse(
        Long id,
        String eventUuid,
        String gatewayEui,
        String sourceNode,
        String op,
        String aggregateType,
        String aggregateKey,
        Map<String, Object> payload,
        String reason,
        String reasonDetail,
        Long contractVersion,
        Instant occurredAt,
        Instant receivedAt) {

    static SyncDeadLetterResponse from(SyncDeadLetter d) {
        return new SyncDeadLetterResponse(
                d.getId(), d.getEventUuid(), d.getGatewayEui(), d.getSourceNode(), d.getOp(),
                d.getAggregateType(), d.getAggregateKey(), d.getPayload(), d.getReason(),
                d.getReasonDetail(), d.getContractVersion(), d.getOccurredAt(), d.getReceivedAt());
    }
}
```

Create `src/main/java/org/osi/server/sync/SyncDeadLetterAdminController.java` with exactly:

```java
package org.osi.server.sync;

import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Read-only dead-letter listing (spec §D). Deliberately NO requeue action: there is no
 * reprocessing pipeline to feed, and every current rejection reason is a permanent
 * classification — requeueing would fail identically (YAGNI, noted in the spec).
 * Mirrors the SyncHealthController admin precedent.
 */
@RestController
@RequestMapping("/api/v1/admin/sync-dead-letters")
@RequiredArgsConstructor
public class SyncDeadLetterAdminController {

    private final SyncDeadLetterRepository repository;

    @GetMapping
    @PreAuthorize("hasAnyRole('ADMIN','SUPER_ADMIN')")
    public ResponseEntity<List<SyncDeadLetterResponse>> list(
            @RequestParam(required = false) String gatewayEui,
            @RequestParam(defaultValue = "100") int limit) {
        int boundedLimit = Math.max(1, Math.min(limit, 500));
        Pageable page = PageRequest.of(0, boundedLimit);
        List<SyncDeadLetter> rows = (gatewayEui == null || gatewayEui.isBlank())
                ? repository.findAllByOrderByReceivedAtDesc(page)
                : repository.findByGatewayEuiOrderByReceivedAtDesc(gatewayEui.trim().toUpperCase(), page);
        return ResponseEntity.ok(rows.stream().map(SyncDeadLetterResponse::from).toList());
    }
}
```

- [ ] **Step 5.6: Controller test** — create `src/test/java/org/osi/server/sync/SyncDeadLetterAdminControllerTest.java` with exactly:

```java
package org.osi.server.sync;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageRequest;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SyncDeadLetterAdminControllerTest {

    @Mock
    private SyncDeadLetterRepository repository;

    @InjectMocks
    private SyncDeadLetterAdminController controller;

    private static SyncDeadLetter dead() {
        return SyncDeadLetter.builder()
                .id(1L).eventUuid("evt-dl-1").gatewayEui("00AA00AA00AA00AA")
                .op("DEVICE_DATA_APPENDED").reason("integrity_violation")
                .payload(Map.of("k", "v")).receivedAt(Instant.now())
                .build();
    }

    @Test
    void listsPerGatewayNormalizedAndBounded() {
        when(repository.findByGatewayEuiOrderByReceivedAtDesc(eq("00AA00AA00AA00AA"), eq(PageRequest.of(0, 500))))
                .thenReturn(List.of(dead()));

        var response = controller.list("00aa00aa00aa00aa", 9999); // lowercase + over-limit

        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(response.getBody()).hasSize(1);
        assertThat(response.getBody().get(0).reason()).isEqualTo("integrity_violation");
        verify(repository).findByGatewayEuiOrderByReceivedAtDesc("00AA00AA00AA00AA", PageRequest.of(0, 500));
    }

    @Test
    void listsFleetWideWhenGatewayOmitted() {
        when(repository.findAllByOrderByReceivedAtDesc(PageRequest.of(0, 100)))
                .thenReturn(List.of(dead()));

        var response = controller.list(null, 100);

        assertThat(response.getBody()).hasSize(1);
        verify(repository).findAllByOrderByReceivedAtDesc(PageRequest.of(0, 100));
    }

    @Test
    void limitIsFlooredAtOne() {
        when(repository.findAllByOrderByReceivedAtDesc(PageRequest.of(0, 1))).thenReturn(List.of());

        controller.list(null, -5);

        verify(repository).findAllByOrderByReceivedAtDesc(PageRequest.of(0, 1));
    }
}
```

- [ ] **Step 5.7: Micrometer check (spec §D conditional)** — run `grep -i micrometer build.gradle.kts`. Expected at planning time: no match → **skip the batch counters** and note them as a deferred follow-up in the PR body (they belong with 1.B3's metrics registry). If 1.B3 has landed Micrometer by execution time, add `Counter` increments per `SyncEventResult.Status` in `applyEventsV2`'s loop as a separate commit.

- [ ] **Step 5.8: Run + commit**

Run: `./gradlew test --tests 'org.osi.server.retention.*' --tests 'org.osi.server.sync.SyncDeadLetterAdminControllerTest' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: PASS.

```bash
git add src/main/java/org/osi/server/retention/SyncDeadLetterRetentionJob.java \
        src/main/java/org/osi/server/retention/DbHealthCounters.java \
        src/main/java/org/osi/server/sync/SyncDeadLetterResponse.java \
        src/main/java/org/osi/server/sync/SyncDeadLetterAdminController.java \
        src/test/java/org/osi/server/retention/SyncDeadLetterRetentionJobTest.java \
        src/test/java/org/osi/server/sync/SyncDeadLetterAdminControllerTest.java
git commit -m "feat(sync): dead-letter retention (90d) + health counter + read-only admin listing (1.B4 spec C/D)"
```

---

### Task 6: Batch-size cap (400) + gateway-EUI-keyed rate limit (429)

**Files:**
- Modify: `src/main/java/org/osi/server/sync/EdgeSyncController.java`
- Modify: `src/main/java/org/osi/server/security/RateLimitFilter.java`
- Modify: `src/main/java/org/osi/server/config/SecurityConfig.java`
- Modify: `src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java`
- Create: `src/test/java/org/osi/server/security/RateLimitSyncEventsTest.java`

**Interfaces:**
- Cap: `events.size() > 100` → `400` with a JSON body naming the limit — **protocol-2 requests only** (planning refinement of spec §E, report upward: legacy V1 edges' batch size cannot be verified from the repo, and a 400-wedge on a legacy gateway is worse than an unbounded legacy batch, which the rate limit still bounds; the #87 catch-up runs on current protocol-2 flows after a full deploy, so the cap covers the gate scenario). 100 = the edge's own verified `LIMIT 100`. Checked after auth, before dispatch.
- Rate limit: 10 req/min keyed by the gateway EUI from the **sync JWT** (`JwtTokenProvider.getGatewayDeviceEuiFromToken`, resolver injected as a `Function` so `RateLimitFilter` stays a plain non-bean object); invalid/absent token falls back to IP identity (those requests 403 in the controller anyway). 10/min = 5× the verified 2 req/min steady state; at ceiling = 1,000 events/min ≈ 60k/hour drain (spec §E arithmetic — never binds under automatic edge behavior; operator force-sync bursts are the only realistic approach to it). Both 429 and 400 are leave-untouched-retry-next-tick at the edge (verified) — the status split aids server logs/triage only.

- [ ] **Step 6.1: Write the failing cap test** — in `src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java`, add this test method (imports needed: `java.util.ArrayList`, `org.mockito.Mockito.verifyNoInteractions` — add to the existing import block):

```java
    @Test
    void applyEvents_rejectsOversizedProtocol2BatchBeforeDispatch() {
        org.osi.server.user.User user = org.osi.server.user.User.builder().id(7L).username("alice").build();
        Device gateway = Device.builder()
                .deviceEui("GW-1234")
                .type("GATEWAY")
                .claimedBy(user)
                .build();
        UserDetails principal = new User("alice", "ignored", List.of());
        var oversized = new ArrayList<EdgeSyncService.SyncEventRecord>();
        for (int i = 0; i < 101; i++) {
            oversized.add(new EdgeSyncService.SyncEventRecord(
                    "evt-" + i, "DEVICE", "KIWI-1", "DEVICE_FLAGS_UPDATED", (long) i,
                    "2026-07-07T09:15:00Z", Map.of("device_eui", "KIWI-1")));
        }
        EdgeSyncService.EdgeEventBatchRequest request =
                new EdgeSyncService.EdgeEventBatchRequest("edge-1", "GW-1234", oversized);

        when(jwtTokenProvider.validateToken("sync-token")).thenReturn(true);
        when(jwtTokenProvider.isSyncToken("sync-token")).thenReturn(true);
        when(jwtTokenProvider.getGatewayDeviceEuiFromToken("sync-token")).thenReturn("gw-1234");
        when(jwtTokenProvider.getUsernameFromToken("sync-token")).thenReturn("alice");
        when(jwtTokenProvider.getUserIdFromToken("sync-token")).thenReturn(7L);
        when(userService.findByUsername("alice")).thenReturn(user);
        when(deviceService.findByEui("GW-1234")).thenReturn(gateway);

        var response = edgeSyncController.applyEvents(principal, "Bearer sync-token", "2", request);

        assertThat(response.getStatusCode().value()).isEqualTo(400);
        assertThat(String.valueOf(response.getBody())).contains("batch_too_large");
        verifyNoInteractions(edgeSyncService);
    }
```

Run: `./gradlew test --tests 'org.osi.server.sync.EdgeSyncControllerTest' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL — the new test gets a 200 (no cap exists yet); existing tests still pass.

- [ ] **Step 6.2: Implement the cap** — in `src/main/java/org/osi/server/sync/EdgeSyncController.java`, add the constant after the field declarations:

```java
    /** Server-side backstop matching the edge's own verified outbox drain LIMIT 100 (spec §E). */
    static final int MAX_EVENTS_PER_BATCH = 100;
```

and in `applyEvents(...)`, after the authorization guard (`if (!isAuthorizedForGateway(...)) { return ... 403 ... }`) and before the protocol branch, insert:

```java
        if ("2".equals(syncProtocol) && request.events().size() > MAX_EVENTS_PER_BATCH) {
            // Protocol-2 only: current edge flows self-cap at LIMIT 100, so this is
            // defense-in-depth against a misbehaving/future build. Legacy V1 batch sizes
            // are unverifiable from this repo — a 400-wedge on a legacy gateway would be
            // worse than an unbounded legacy batch (which the rate limit still bounds).
            // NOTE (spec §E): the edge treats 400 exactly like 429 — leave rows untouched,
            // retry next tick — so an oversized batch retries forever; the wedge is
            // edge-visible via sync_outbox growth/heartbeat, not self-healing.
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "batch_too_large",
                    "maxEvents", MAX_EVENTS_PER_BATCH,
                    "receivedEvents", request.events().size()));
        }
```

Run: `./gradlew test --tests 'org.osi.server.sync.EdgeSyncControllerTest' -x buildFrontend -x buildTerraIntelligenceFrontend` → PASS.

- [ ] **Step 6.3: Write the failing rate-limit test** — create `src/test/java/org/osi/server/security/RateLimitSyncEventsTest.java` with exactly:

```java
package org.osi.server.security;

import jakarta.servlet.ServletException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThat;

class RateLimitSyncEventsTest {

    private static final String PATH = "/api/v1/sync/edge/events";

    private static MockHttpServletRequest post(String bearer) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", PATH);
        request.setRemoteAddr("203.0.113.10");
        if (bearer != null) {
            request.addHeader("Authorization", "Bearer " + bearer);
        }
        return request;
    }

    private static int run(RateLimitFilter filter, MockHttpServletRequest request)
            throws ServletException, IOException {
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, new MockFilterChain());
        return response.getStatus();
    }

    @Test
    void syncEventsPathIsFiltered() {
        RateLimitFilter filter = new RateLimitFilter(token -> "00AA00AA00AA00AA");
        assertThat(filter.shouldNotFilter(post("tok"))).isFalse();
    }

    @Test
    void allowsTenPerMinutePerGatewayThenReturns429() throws Exception {
        RateLimitFilter filter = new RateLimitFilter(token -> "00AA00AA00AA00AA");
        for (int i = 0; i < 10; i++) {
            assertThat(run(filter, post("tok-a"))).as("request %d", i + 1).isEqualTo(HttpStatus.OK.value());
        }
        assertThat(run(filter, post("tok-a"))).isEqualTo(HttpStatus.TOO_MANY_REQUESTS.value());
    }

    @Test
    void distinctGatewaysHaveIndependentBuckets() throws Exception {
        RateLimitFilter filter = new RateLimitFilter(
                token -> token.equals("tok-a") ? "00AA00AA00AA00AA" : "00BB00BB00BB00BB");
        for (int i = 0; i < 10; i++) {
            run(filter, post("tok-a"));
        }
        assertThat(run(filter, post("tok-a"))).isEqualTo(HttpStatus.TOO_MANY_REQUESTS.value());
        assertThat(run(filter, post("tok-b"))).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void invalidTokenFallsBackToIpIdentity() throws Exception {
        RateLimitFilter filter = new RateLimitFilter(token -> {
            throw new IllegalStateException("bad token");
        });
        // Falls back to IP identity; request proceeds (auth will 403 it later).
        assertThat(run(filter, post("garbage"))).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void missingResolverFallsBackToIpIdentity() throws Exception {
        RateLimitFilter filter = new RateLimitFilter(); // legacy no-arg constructor
        assertThat(run(filter, post(null))).isEqualTo(HttpStatus.OK.value());
    }
}
```

Run: `./gradlew test --tests 'org.osi.server.security.RateLimitSyncEventsTest' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL — no `RateLimitFilter(Function)` constructor; `shouldNotFilter` returns true for the path.

- [ ] **Step 6.4: Implement the filter changes** — modify `src/main/java/org/osi/server/security/RateLimitFilter.java`:

**(a)** Update the class javadoc line to `* Allows 10 auth requests per minute per IP address, 60 calibration lookups per minute per token, and 10 sync event batches per minute per gateway EUI.`

**(b)** Add the import `java.util.function.Function` and the constant + field + constructors (replacing the existing single constructor):

```java
    static final String SYNC_EVENTS_PATH = "/api/v1/sync/edge/events";

    private final Function<String, String> syncGatewayEuiResolver;

    public RateLimitFilter() {
        this(null);
    }

    public RateLimitFilter(Function<String, String> syncGatewayEuiResolver) {
        this.trustedProxyMatchers = parseTrustedProxies(System.getProperty(TRUSTED_PROXY_PROPERTY, "127.0.0.1/32"));
        this.syncGatewayEuiResolver = syncGatewayEuiResolver;
    }
```

**(c)** Extend `shouldNotFilter`:

```java
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !path.startsWith("/auth/")
                && !path.startsWith("/api/v1/sync/chameleon/calibrations/")
                && !path.equals(SYNC_EVENTS_PATH);
    }
```

**(d)** Extend `doFilterInternal`'s dispatch (replace the current `calibrationLookup`/`capacity`/`identity`/`bucket` block):

```java
        String path = request.getRequestURI();
        boolean calibrationLookup = path.startsWith("/api/v1/sync/chameleon/calibrations/");
        boolean syncEvents = path.equals(SYNC_EVENTS_PATH);
        // 10/min per gateway = 5x the verified 30 s edge cadence (2/min); at ceiling a
        // backlog drain still moves 10 x 100 = 1,000 events/min (spec §E arithmetic).
        int capacity = calibrationLookup ? 60 : 10;
        String prefix = syncEvents ? "sync:" : (calibrationLookup ? "cal:" : "auth:");
        String identity = syncEvents ? resolveGatewayIdentity(request)
                : (calibrationLookup ? resolveTokenIdentity(request) : resolveIdentity(request));
        Bucket bucket = buckets.computeIfAbsent(prefix + identity, k -> newBucket(capacity));
```

**(e)** Add the resolver method after `resolveTokenIdentity`:

```java
    String resolveGatewayIdentity(HttpServletRequest request) {
        // Keyed by the authenticated gateway EUI from the sync JWT (spec §E) — not by IP:
        // gateways can share NAT/proxy IPs in the field. Invalid or absent tokens fall
        // back to IP identity; those requests are 403'd by the controller anyway.
        String authorization = request.getHeader("Authorization");
        if (syncGatewayEuiResolver != null && authorization != null && authorization.startsWith("Bearer ")) {
            try {
                String eui = syncGatewayEuiResolver.apply(authorization.substring(7));
                if (eui != null && !eui.isBlank()) {
                    return eui.trim().toUpperCase();
                }
            } catch (Exception ignored) {
                // fall through to IP identity
            }
        }
        return resolveIdentity(request);
    }
```

**(f)** Wire it in `src/main/java/org/osi/server/config/SecurityConfig.java` — add the import `org.osi.server.security.JwtTokenProvider`, add the field `private final JwtTokenProvider jwtTokenProvider;` next to the existing fields, and change line 69 to:

```java
            .addFilterBefore(new RateLimitFilter(jwtTokenProvider::getGatewayDeviceEuiFromToken), UsernamePasswordAuthenticationFilter.class)
```

- [ ] **Step 6.5: Run it (green) + regression**

Run: `./gradlew test --tests 'org.osi.server.security.*' --tests 'org.osi.server.sync.EdgeSyncControllerTest' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: all pass, including the pre-existing `RateLimitProxyIdentityTest` (the no-arg constructor is preserved).

- [ ] **Step 6.6: Commit**

```bash
git add src/main/java/org/osi/server/sync/EdgeSyncController.java \
        src/main/java/org/osi/server/security/RateLimitFilter.java \
        src/main/java/org/osi/server/config/SecurityConfig.java \
        src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java \
        src/test/java/org/osi/server/security/RateLimitSyncEventsTest.java
git commit -m "feat(sync): protocol-2 batch cap (400) + gateway-EUI Bucket4j rate limit on /edge/events (1.B4 spec E)"
```

---

### Task 7: Synthetic backlog-drain test + full gate + PR

**Files:**
- Create: `src/test/java/org/osi/server/sync/BacklogDrainIT.java`

**Interfaces:** the Uganda-shaped scenario (spec §G): 5,000 events in 50 batches of 100 (mirroring the edge's real batching), 1-in-500 poison mix, proving throughput and zero cross-event contamination.

- [ ] **Step 7.1: Write the drain test** — create `src/test/java/org/osi/server/sync/BacklogDrainIT.java` with exactly:

```java
package org.osi.server.sync;

import org.junit.jupiter.api.Test;
import org.osi.server.analytics.ZoneEnvironmentService;
import org.osi.server.command.CommandLeaseService;
import org.osi.server.command.CommandService;
import org.osi.server.device.DeviceService;
import org.osi.server.security.EdgeOwnershipService;
import org.osi.server.soil.ZoneSoilProfileService;
import org.osi.server.testsupport.PostgresSyncTestBase;
import org.osi.server.user.LinkedGatewayAccountService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Synthetic backlog drain (spec §G): a weeks-stale gateway replaying its outbox in
 * 100-event batches with an occasional poison event — the #87 Uganda scenario. Proves
 * reconciliation (no event silently lost), zero cross-event contamination, and smoke
 * throughput. Timing bound is a smoke assertion, not an SLA — tune after observing.
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
@Import({EdgeSyncService.class, SyncEventTxExecutor.class, SyncPayloadCanonicalizer.class})
class BacklogDrainIT extends PostgresSyncTestBase {

    private static final String GW = "20BB20BB20BB20BB"; // unique to this IT class
    private static final int TOTAL = 5000;
    private static final int POISON_EVERY = 500;
    private static final int BATCH = 100;

    @Autowired private EdgeSyncService edgeSyncService;
    @Autowired private SyncInboxRepository inboxRepository;
    @Autowired private SyncDeadLetterRepository deadLetterRepository;
    @Autowired private SyncResourceWatermarkRepository watermarkRepository;

    @MockBean private DeviceService deviceService;
    @MockBean private CommandService commandService;
    @MockBean private CommandLeaseService commandLeaseService;
    @MockBean private ZoneSoilProfileService zoneSoilProfileService;
    @MockBean private ZoneEnvironmentService zoneEnvironmentService;
    @MockBean private LinkedGatewayAccountService linkedGatewayAccountService;
    @MockBean private EdgeOwnershipService ownershipService;

    private static boolean isPoison(int i) {
        return i % POISON_EVERY == 0; // i = 500, 1000, ... 5000 -> 10 poison events
    }

    private static String uuidFor(int i) {
        return isPoison(i)
                ? String.format("bd-poison-%04d-%s", i, "x".repeat(25)) // 40 chars: unstorable in sync_inbox VARCHAR(36)
                : String.format("bd-evt-%04d", i);
    }

    private static EdgeSyncService.SyncEventRecord event(int i) {
        return new EdgeSyncService.SyncEventRecord(
                uuidFor(i), "GATEWAY", GW, "GATEWAY_LOCATION_UPSERTED", (long) i,
                "2026-07-07T10:00:00Z",
                Map.of("contract_version", "1",
                        "gateway_device_eui", GW,
                        "latitude", 40.0 + (i % 100) / 100.0,
                        "longitude", 7.1,
                        "sync_version", String.valueOf(i)));
    }

    @Test
    void drainsFiftyPoisonedBatchesWithoutCrossContamination() {
        long started = System.currentTimeMillis();
        Map<SyncEventResult.Status, Integer> tally = new EnumMap<>(SyncEventResult.Status.class);

        for (int batchStart = 1; batchStart <= TOTAL; batchStart += BATCH) {
            List<EdgeSyncService.SyncEventRecord> batch = new ArrayList<>(BATCH);
            for (int i = batchStart; i < batchStart + BATCH; i++) {
                batch.add(event(i));
            }
            SyncEventBatchResponse response = edgeSyncService.applyEventsV2(
                    new EdgeSyncService.EdgeEventBatchRequest("edge-bd", GW, batch));
            assertThat(response.results()).hasSize(BATCH);
            for (SyncEventResult r : response.results()) {
                tally.merge(r.getStatus(), 1, Integer::sum);
            }
        }
        long elapsedMs = System.currentTimeMillis() - started;

        // Reconciliation: every event accounted for, none silently dropped.
        int poisonCount = TOTAL / POISON_EVERY; // 10
        assertThat(tally.getOrDefault(SyncEventResult.Status.APPLIED, 0)).isEqualTo(TOTAL - poisonCount);
        assertThat(tally.getOrDefault(SyncEventResult.Status.REJECTED, 0)).isEqualTo(poisonCount);
        assertThat(tally.getOrDefault(SyncEventResult.Status.RETRYABLE_ERROR, 0)).isZero();
        assertThat(tally.getOrDefault(SyncEventResult.Status.DUPLICATE, 0)).isZero();

        // No cross-event contamination: every non-poison event committed...
        for (int i : new int[]{1, 499, 501, 2500, 4999}) {
            assertThat(inboxRepository.existsById(uuidFor(i))).as("inbox %d", i).isTrue();
        }
        // ...every poison dead-lettered with its payload, and absent from the inbox.
        for (int i = POISON_EVERY; i <= TOTAL; i += POISON_EVERY) {
            assertThat(deadLetterRepository.existsByEventUuid(uuidFor(i))).as("dead-letter %d", i).isTrue();
            assertThat(inboxRepository.existsById(uuidFor(i))).as("not inbox %d", i).isFalse();
        }
        // Watermark advanced to the highest applied version (4999: 5000 was poison).
        assertThat(watermarkRepository.find(GW, "GATEWAY", GW).orElseThrow()
                .getHighestSyncVersion()).isEqualTo(4999L);

        // Smoke throughput: a weeks-scale backlog must drain in minutes locally.
        assertThat(elapsedMs).as("drain wall-clock ms").isLessThan(120_000L);
    }
}
```

- [ ] **Step 7.2: Run it**

Run: `./gradlew test --tests 'org.osi.server.sync.BacklogDrainIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: PASS, well under the 120 s bound (record the actual elapsed time from the test log for the PR body). If the timing assertion is the only failure on slow hardware, raise the bound in one commit with the observed number — do not delete the assertion.

- [ ] **Step 7.3: Full local gate (the repo has no CI — this IS the gate)**

```bash
cd /home/phil/Repos/osi-server/backend && ./gradlew clean test
```

Expected: BUILD SUCCESSFUL — all pre-existing Mockito tests + the new classifier/controller/retention unit tests + the four IT classes green, frontend builds included (the full un-skipped run, once, before the PR).

- [ ] **Step 7.4: Commit + push + PR (do NOT merge)**

```bash
git add src/test/java/org/osi/server/sync/BacklogDrainIT.java
git commit -m "test(sync): synthetic 5k backlog-drain with poison mix — reconciliation + no cross-contamination (1.B4/DD15)"
git push -u origin feat/sync-ingest-hardening
```

Open the PR in **osi-server** with `gh pr create --repo <osi-server-remote> --title "Sync-ingest hardening: per-event tx boundary, sync_dead_letter, batch cap, gateway rate limit (1.B4)" --body-file <(...)` containing, per the spec and program requirements:

1. **Root cause:** `applyEventsV2` wrapped every 100-event batch in one `@Transactional`; one poison event marked it rollback-only, the whole batch failed at commit — including the inbox dedup rows of events that succeeded — and the edge re-sent the identical batch forever.
2. **The two-surface exception model, in two sentences:** validation faults thrown by our own frames are classified inside `applyOne` while its `REQUIRES_NEW` transaction is still healthy; repository/flush/commit-time faults surface in `applyEventsV2`'s loop (the commit fires at the proxy boundary), where a classifier dead-letters permanent integrity violations via a fresh-transaction `recordRejection` and returns everything else as retryable.
3. **Verified edge-compat facts:** edge treats every non-2xx (429/400 included) as leave-rows-untouched-retry-next-tick; `REJECTED` is terminal edge-side (`rejected_at`/`rejection_reason` written, row never re-sent); wire shape of `SyncEventBatchResponse` unchanged; zero edge deployment needed.
4. **Evidence:** poison-batch IT output (both classifier branches), backlog-drain IT output with the observed wall-clock time, full `./gradlew clean test` summary line.
5. **Gate line:** "Part of the refactor program item 1.B4; **hard gate for #87 — the Uganda catch-up must not run before this merges and deploys**."
6. **Deferred (with pointers):** runtime JSON-Schema validation → Phase 3 contract-fixtures item (spec §F: no schema mirror/parity mechanism exists in osi-server yet); Micrometer batch counters → 1.B3 (no metrics registry on the classpath yet); `sync_dead_letter_total` DB counter ships now regardless.
7. **Behavioral notes for reviewers:** ownership-denied and missing-uuid paths (see plan Task 4 interfaces + spec deltas below); the watermark-semantics note that a retryable event whose successors already applied will be `stale_sync_version`-rejected on verbatim re-send (benign for last-writer-wins upserts; append-only telemetry has per-row watermark slots).

## Follow-ups (not in this plan)

- 1.B3: CI workflow running `./gradlew test` (Docker available on GitHub runners → these Testcontainers ITs become the merge gate), Micrometer registry + the deferred batch counters, GHCR pull-only deploys.
- Phase 3 contract-fixtures item: runtime JSON-Schema validation at ingest → dead-letter `reason=schema_violation` (hook point documented in spec §F).
- #87 runbook note: a 429 during operator force-sync bursts shows up as a failed outbox phase in the GUI — cosmetic, data-safe, expect it.
- After merge + deploy to the test server, then production: observe `sync_dead_letter_total` and the admin listing during the kaba100/Silvan window before green-lighting the Uganda catch-up (program 2.1).
