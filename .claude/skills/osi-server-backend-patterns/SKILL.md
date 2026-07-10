---
name: osi-server-backend-patterns
description: Use when osi-server backend, frontend, API, sync, Flyway migration, Spring service/controller, Gradle build, Terra, or prediction-service changes are involved.
---

# OSI Server Backend Patterns

## Overview

This skill is available from the `osi-os` skill tree for paired-repo awareness.
Stage 1 Forge indexes `osi-os` only, so this server skill is ready for Stage 2
but should not be added to the Stage 1 forge index.

Verified sources to re-check before server work:

- `/home/phil/Repos/osi-server/AGENTS.md`.
- `/home/phil/Repos/osi-server/backend/build.gradle.kts`.
- `/home/phil/Repos/osi-server/backend/src/main/resources/application.yml`.
- `/home/phil/Repos/osi-server/architect.yaml` and `RULES.yaml`.
- `/home/phil/Repos/osi-server/docs/agents/typescript-rule-overlays.md`.

## Stack Facts

- Java source/target compatibility is 17; local/runtime prerequisite is JRE 21.
- Lombok is used throughout; prefer constructor injection with
  `@RequiredArgsConstructor`.
- Gradle builds the React frontend and Terra frontend into the Spring JAR
  through `processResources`.
- `docker/frontend/Dockerfile` and `docker/frontend/nginx.conf` are legacy and
  unused for current serving; the Spring JAR serves `classpath:/static/`.

## Flyway Discipline

- Hibernate `ddl-auto` is `validate`; never switch it to `create` or `update`.
- Migrations live in `backend/src/main/resources/db/migration/`.
- Existing migrations include legacy numeric `V<N>__...` files and newer
  date-versioned `V2026_MM_DD_*` files. Never renumber or edit an applied
  migration.
- New date-versioned migrations must sort after the highest applied production
  version. Re-check with:

```sql
SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 5;
```

Postgres pitfalls already hit in this repo:

- Newly added enum values cannot be referenced by later DDL in the same Flyway
  transaction. Split enum adds from the DDL that uses them.
- Partial index predicates cannot use non-IMMUTABLE expressions such as enum
  casts to text. Use direct enum comparison where applicable.
- Provenance: see
  `V2026_05_16_011__device_commands_lease_columns.sql` and
  `V2026_05_16_012__device_commands_lease_columns_apply.sql`.

## Test Conventions

- Backend unit tests normally use JUnit 5, `@ExtendWith(MockitoExtension.class)`,
  Mockito, and AssertJ.
- For current work-request-style units, repositories are mocked; do not add a
  database dependency unless the task explicitly needs integration coverage.
- Backend test command:

```bash
cd /home/phil/Repos/osi-server/backend && ./gradlew test
```

Other surfaces:

```bash
cd /home/phil/Repos/osi-server/frontend && npm run test:unit
cd /home/phil/Repos/osi-server/terra-intelligence && npm test
cd /home/phil/Repos/osi-server/prediction-service && pytest
```

## Build Commands

Full build:

```bash
cd /home/phil/Repos/osi-server/backend && ./gradlew build
```

Backend-only JAR without tests or frontend rebuilds:

```bash
cd /home/phil/Repos/osi-server/backend && ./gradlew bootJar --no-daemon -x test -x buildFrontend -x buildTerraIntelligenceFrontend
```

If Terra changed, do not skip `buildTerraIntelligenceFrontend` unless the task
is explicitly backend-only and the skipped surface is irrelevant.

## API Shape Bridge

`frontend/src/services/api.ts` owns the cloud frontend compatibility bridge.
`normaliseDevice()` and `normaliseZone()` map camelCase Spring JSON to
snake_case legacy/edge-compatible fields. New endpoints must choose where the
bridge lives and keep normalization in services, not presentational components.

Synced resource mutations remain edge-first: cloud edits for gateway-backed
farms are pending until the edge applies them through sync commands.

## Misc Traps

- `DeviceType` is a string-constant class at
  `backend/src/main/java/org/osi/server/device/DeviceType.java`, not a Java enum.
- `SecurityConfig` wires `new RateLimitFilter()`; Bucket4j limits live in
  `backend/src/main/java/org/osi/server/security/RateLimitFilter.java`.
- `DataInitializer` requires an enabled super-admin or complete
  `SUPERADMIN_*`/`ADMIN_*` bootstrap env; otherwise startup fails.
- No ESLint/Prettier is configured for the frontend.
- TypeScript overlays apply in both `frontend/` and `terra-intelligence/`.
- MQTT is edge-to-cloud only for telemetry/status/ACK. Do not revive
  deprecated `MqttPublisherService` for cloud-to-edge commands.

## Common Mistakes

- Editing an applied Flyway migration instead of adding a new one.
- Adding a date-versioned migration that sorts before already-applied versions.
- Using a Postgres enum value in the same migration that added it.
- Moving camelCase/snake_case compatibility into React components.
- Treating cloud state as canonical for edge-backed synced resources.
- Adding DB-backed tests to simple Mockito unit work without a clear need.
- Skipping frontend or Terra tests after changing their service/type contracts.

## Re-Verification

Use the touched surface to choose gates, then report real output:

- Backend Java/API/Flyway: `cd backend && ./gradlew test`.
- Full packaged behavior: `cd backend && ./gradlew build`.
- Cloud frontend: `cd frontend && npm run test:unit && npm run build`.
- Terra: `cd terra-intelligence && npm test && npm run build`.
- Prediction service: `cd prediction-service && pytest`.
- Sync contract mirror changes: run the relevant `osi-os` sync contract
  verifiers as well as server tests.
