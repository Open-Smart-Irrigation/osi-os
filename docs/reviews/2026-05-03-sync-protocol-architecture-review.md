# Sync Protocol & Architecture Review

**Date:** 2026-05-03
**Scope:** `osi-os` edge sync → `osi-server` cloud sync (REST protocol, SQLite/PostgreSQL schemas, command delivery, frontend normalization)
**Agents:** 4 parallel review agents + 3 follow-up audit agents
**Complement to:** `osi-server/docs/reviews/2026-05-03-full-stack-code-review.md` (covers frontend, prediction service, valve safety — not duplicated here)

---

## 1. Executive Summary

The sync protocol's happy-path design is sound: REST polling, inbox/outbox dedup, edge-first semantics, and the bootstrap+events+commands cadence all work for a single linked gateway. The risks are concentrated in **failure handling** (silent event/command loss, swallowed exceptions, transport errors), **unbounded operational data** (no retention on outbox/inbox), and **implicit contract assumptions** (no payload validation, UUID format drift, EUI normalization asymmetry, casing inconsistency between frontends). The server-side `EdgeSyncService` (1,503 lines, ~30 dependencies) is a critical maintainability risk that couples 12+ entity types inside a single `@Transactional` boundary.

All findings below map directly to the [refactor spec](../specs/2026-05-03-sync-contract-refactor-design.md) findings catalog.

---

## 2. Sync Protocol Findings

### Critical

| # | Finding | Location | Impact |
|---|---------|----------|--------|
| **C1** | Bootstrap has no sync_version gate. A stale full snapshot from a restored gateway backup can overwrite newer cloud mirror state. | `EdgeSyncService.java:87-158` — `applyBootstrap()` does not inspect `sync_version` on any entity | Data regression from backup restore |
| **C2** | `isStale` uses `<` not `<=`. Equal-version events always pass as fresh, so duplicate delivery of the same-version event can silently rewrite state. | `EdgeSyncService.java:1184-1186` | Silent state overwrite on replay |
| **C3** | Cloud UI writes and edge events can stomp each other at the same `sync_version` when `isEdgeBacked` is false. | `EdgeSyncService.java:539-593` | Lost writes on concurrent modification |
| **C4** | `applyEvents` catches broad `Exception` per event. The edge marks ALL events delivered on HTTP 200 regardless of per-event skip count. | `EdgeSyncService.java:186-189` + `flows.json:5814` | Permanent event loss with no retry |
| **C5** | Edge HTTP sync nodes have `"senderr": false` — DNS failures, TLS handshake failures, and connection refused produce no `statusCode`, so the error check `if (msg.statusCode && (msg.statusCode < 200...))` evaluates false and errors are silently swallowed. | `flows.json:5695,5790,5885` | Silent transport failure |
| **C6** | 403 Forbidden on sync endpoints never self-heals. Unlinked gateways retry every 30s forever with no token refresh or re-link trigger. | `flows.json:5719,5814,5909` | Permanent sync deadlock after unlink |
| **C7** | Token refresh races with outbox/pending-command polls. If the refresh response arrives but hasn't been persisted to SQLite yet, the next poll uses an expired token and fails silently. | `flows.json:5989,5741,5836` | Intermittent auth failure |
| **C8** | `sync_outbox` and `sync_inbox` rows are marked `delivered_at`/`processed_at` but never pruned. At 30s polling, ~10M rows/year per gateway. | `flows.json:5814` + `EdgeSyncService.java:297` + `SyncInboxEvent.java` | Unbounded table growth |

### High

| # | Finding | Location | Impact |
|---|---------|----------|--------|
| **H1** | TOCTOU gap in event dedup: two concurrent `applyEvents` calls can both pass `existsByEventUuid` and double-process the same event. | `EdgeSyncService.java:170-173` | Duplicate event application |
| **H2** | Event batches have no sequence number. If batch B arrives before batch A (network reordering), the cursor updates to whichever arrives last, masking reordering. | `EdgeSyncService.java:191-195` | Silent reordering |
| **H3** | `syncVersion` defaults to `zone.getSyncVersion()` when missing from payload, masking stale writes by tying with current version. | `EdgeSyncService.java:551-553` | Stale data accepted as fresh |
| **H4** | Zone soft-delete does not cascade to `irrigation_schedules`. Schedules remain attached to deleted zones. | `EdgeSyncService.java:587,595-615` | Orphaned schedule rows |
| **H5** | No `DEVICE_DELETED` event handler in the event switch. Device deletion is handled only via `DEVICE_UNASSIGNED`/`DEVICE_UNCLAIMED`. | `EdgeSyncService.java:277-293` | No device tombstone sync |
| **H6** | No exactly-once command delivery. MQTT ACK is the only dedup path; if MQTT is down, commands are re-served on every REST poll. | `CommandService.java:124,139-143` | Duplicate command application |
| **H7** | Force-sync replays commands with fresh `eventUuid`, so the edge cannot distinguish replayed commands from new ones. | `LinkedGatewaySyncService.java:150-161` | Double command application |
| **H8** | Reconciliation is diagnostic-only — returns counts and metadata but does not trigger repair. | `EdgeSyncService.java:236-256` | Drift detected but not fixed |
| **H9** | No content-level integrity check in reconciliation — per-entity hash, Merkle tree, or record count per type. A gateway with 3 wrong zone names appears fully reconciled. | `EdgeSyncService.java:236-256` | Silent content drift |

---

## 3. Database Schema Findings

### Critical

| # | Finding | Location |
|---|---------|----------|
| **D1** | `trigger_metric` CHECK on edge SQLite rejects `'SWT_1'` (cloud default). The cloud-to-edge config sync breaks for Chameleon SWT. | SQLite `irrigation_schedules` CHECK constraint vs `IrrigationSchedule.java:25` |

### High

| # | Finding | Location |
|---|---------|----------|
| **D2** | UUID format mismatch: edge generates 32-char hex (`lower(hex(randomblob(16)))`), cloud generates 36-char dashed (`UUID.randomUUID().toString()`). Sync identity matching may fail at the sync boundary. | `flows.json:5628` vs `User.java:58`, `IrrigationZone.java:107` |
| **D3** | Chameleon readings table has no UNIQUE constraint. Repeated full syncs duplicate all rows. | `V40__chameleon_full_mirror.sql:20-21` |
| **D4** | Missing index on `sync_inbox (source_node, processed_at DESC)` — queried on every inbound event poll. | `V17__bidirectional_sync_foundation.sql:93-97` |
| **D5** | FK delete behavior differs: edge `irrigation_events` uses CASCADE on user FK; cloud uses SET NULL. Deleting a user on edge silently deletes event history. | `flows.json` irrigation_events vs `V18__data_plane_mirror.sql:17` |
| **D6** | `dendro_readings` FK references differ: edge uses `deveui` (natural key), cloud uses `id` (surrogate key). If deveui changes, edge loses dendro history. | SQLite `dendrometer_readings` vs `V18__data_plane_mirror.sql:31` |

### Medium

| # | Finding | Location |
|---|---------|----------|
| **D7** | Chameleon column types: INTEGER on edge, DOUBLE PRECISION on cloud for resistance columns — precision loss on edge-originated data. | SQLite `chameleon_readings` vs `V40__:37-42` |
| **D8** | Edge stores richer dendrometer diagnostic fields than cloud mirrors (`adc_ch0v`, `dendro_ratio`, `position_raw_um`, etc.). | SQLite `dendrometer_readings` vs `V18__:29-41` |
| **D9** | Timestamp storage: TEXT (ISO 8601 strings) on edge vs TIMESTAMPTZ on cloud. Edge's `datetime('now')` may produce local time, not UTC. | Pervasive across all tables |
| **D10** | Edge `devices` table rebuilt via RENAME pattern (`devices_new` → `devices_old` → `devices_new` → `devices`) with no transaction wrapping — fragile if migration crashes mid-way. | `flows.json` Sync Init node |
| **D11** | Edge migration sets all `sync_version = 1` unconditionally; cloud defaults to 0. Version offset causes false-positive "modified" on first contact. | `flows.json` Sync Init vs `V17__:27,53,61` |
| **D12** | Users table has no `deleted_at` on either side — user deletion cannot be synced. | `V17__:1-23`, `V1__create_users.sql` |
| **D13** | V26/V29/V32: identical COALESCE backfill executed three times — migration history noise. | `V26/29/32__*_zone_water_config.sql` |

---

## 4. Edge Command Handler Audit

**28 command types** dispatched through the `Route Command` node (`flows.json:3509`). Only **1 handler has any idempotency guard** (`SYNC_LINKED_AUTH` — offline verifier version gate). **No `commandId` dedup table exists** in the edge SQLite schema.

### Destructive handlers (17 of 28)

All `SET_LSN50_*`, `SET_KIWI_*`, `SET_STREGA_*`, `VALVE_COMMAND`, `SET_FAN`, `REBOOT`, and `REGISTER_DEVICE` fire ChirpStack downlinks, GPIO writes, system commands, or ChirpStack provisioning API calls on every replay. `VALVE_COMMAND` and STREGA variants also INSERT duplicate `actuator_log` rows.

| Command Type | Side Effects |
|---|---|
| `SET_LSN50_MODE` | ChirpStack downlink + DB UPDATE (DB part is idempotent, downlink is not) |
| `SET_LSN50_INTERVAL` | ChirpStack downlink only |
| `SET_LSN50_INTERRUPT_MODE` | ChirpStack downlink only |
| `SET_LSN50_5V_WARMUP` | ChirpStack downlink only |
| `SET_KIWI_INTERVAL` | ChirpStack downlink only |
| `ENABLE_KIWI_TEMP_HUMIDITY` | ChirpStack downlink only |
| `SET_STREGA_INTERVAL` | ChirpStack downlink + `actuator_log` INSERT |
| `SET_STREGA_TIMED_ACTION` | ChirpStack downlink + `actuator_log` INSERT |
| `SET_STREGA_MAGNET_MODE` | ChirpStack downlink only |
| `SET_STREGA_PARTIAL_OPENING` | ChirpStack downlink + `actuator_log` INSERT |
| `SET_STREGA_FLUSHING` | ChirpStack downlink + `actuator_log` INSERT |
| `VALVE_COMMAND` | ChirpStack downlink + `actuator_log` INSERT + `devices` UPDATE |
| `SET_FAN` | GPIO PWM write |
| `REBOOT` | System reboot |
| `REGISTER_DEVICE` | ChirpStack provisioning API + SQL INSERT |

### DB-only handlers (11 of 28) — already replay-safe

`UPSERT_ZONE`, `DELETE_ZONE`, `UPSERT_SCHEDULE`, `UPDATE_SCHEDULE`, `UPSERT_ZONE_CONFIG`, `UPSERT_ZONE_LOCATION`, `ASSIGN_DEVICE_TO_ZONE`, `REMOVE_DEVICE_FROM_ZONE`, `UPSERT_DEVICE_FLAGS`, `UPSERT_DEVICE_SOIL_DEPTHS`, `UNCLAIM_DEVICE`, `SET_STREGA_MODEL`, `FORCE_EDGE_SYNC` — use INSERT ON CONFLICT or idempotent UPDATE. Safe to replay without guards.

### ACK mechanism

**All ACKs go via MQTT only.** There is zero REST-based command acknowledgement. Three ACK-producing nodes: `Build Schedule ACK` (`flows.json:3588`), `Build Status + ACK` (`:3641`), and inline ACK from downlink handlers. Lost MQTT ACKs are the sole cause of command replays.

### Implication for refactor Spec B

The command lease model proposed in the refactor spec is warranted for the 17 downlink handlers with destructive side effects. For the 11 DB-only handlers, a simpler edge-side `applied_commands(command_id, applied_at, result)` table with a dispatch-layer lookup would be sufficient — no lease infrastructure needed.

---

## 5. Frontend Normalization Audit

### Two independently-evolved normalization layers

| | osi-os (edge) | osi-server (cloud) |
|---|---|---|
| **Backend convention** | `snake_case` (Node-RED/Express) | `camelCase` (Spring Boot Jackson) |
| **Component expectation** | `snake_case` (primary) | `snake_case` (for shared osi-os components) |
| **Normalization functions** | 8 in `web/react-gui/src/services/api.ts` | 7 in `frontend/src/services/api.ts` |
| **Fields actively remapped** | ~20 | ~70 |
| **Shared types** | None — independent `types/farming.ts` (536 vs 1065 lines) |

### Reverse normalization debt

The osi-server frontend translates camelCase **back** to snake_case (`deviceEui`→`deveui`, `deviceCount`→`device_count`) so osi-os-derived React components work. Components defensively read both forms everywhere (`deviceEui ?? deveui`, `trigger_metric ?? triggerMetric`).

### Sync field handling

`syncVersion`, `syncStatus`, `syncPending`, `zoneUuid` — handled on the cloud frontend only via dual-key lookups. **Completely absent** from the edge frontend — the edge SPA has zero awareness of sync metadata.

### Key functions

| Repo | Function | Line | Direction |
|------|----------|------|-----------|
| osi-os | `normaliseDevice` | `api.ts:120` | snake→snake (passthrough + coercion) |
| osi-os | `normaliseZone` | `api.ts:181` | snake→both (adds camelCase aliases) |
| osi-os | `normaliseSchedule` | `api.ts:103` | snake→both |
| osi-server | `normaliseDevice` | `api.ts:130` | camelCase→snake_case (50+ fields) |
| osi-server | `normaliseZone` | `api.ts:360` | camelCase→both |
| osi-server | `normaliseGatewayLocation` | `api.ts:401` | both→camelCase |

### Most commonly remapped fields

`deveui`/`deviceEui`, `type_id`/`type`, `irrigation_zone_id`/`irrigationZoneId`, `device_count`/`deviceCount`, `created_at`/`createdAt`, `updated_at`/`updatedAt`, `trigger_metric`/`triggerMetric`, `threshold_kpa`/`thresholdKpa`, `crop_type`/`cropType`, `soil_type`/`soilType`, `area_m2`/`areaM2`, `gateway_device_eui`/`gatewayDeviceEui`, `sync_version`/`syncVersion`

---

## 6. Test Suite Audit

### Dead test

`EdgeSyncServiceBootstrapTest.applyBootstrap_mirrorsStregaValveStateAndModelMetadata()` (`:306`) — **missing `@Test` annotation**. Full assertion logic exists but never executes. Tests Strega valve state mirroring during bootstrap.

### Tests deprecated code

`CommandServiceTest` imports and mocks `@Deprecated MqttPublisherService` — tests a code path the architecture doc says shouldn't be active.

### Phase 0 baseline test gaps

The refactor spec requires 10 baseline regression tests before Phase 1 begins. Current coverage:

| Required baseline test | Status |
|---|---|
| Skipped event in 200 response | **Partial** — tests UUID dedup only, not other skip reasons |
| Duplicate event UUID | **Covered** (`EdgeSyncServiceControlPlaneTest:73`) |
| Equal sync version with changed payload | **Not covered** — new test needed |
| Stale bootstrap after newer event | **Not covered** — new test needed |
| Repeated command ID (true idempotency) | **Partial** — tests ACK sender mismatch only |
| Missing target resource command | **Not covered** — new test needed |
| SWT_1 schedule command on edge | **Partial** — validation tests exist |
| Chameleon command on edge main | **Not covered** — new test needed |
| 403 sync response | **Covered** (`EdgeSyncControllerTest:60`) |
| Node-RED transport error path | **Not covered** — new test needed |

**5-6 new tests required for Phase 0.** All existing sync tests use mocks (Mockito + `@ExtendWith(MockitoExtension.class)`) — no integration tests, no test DB, no end-to-end sync flow tests. Edge verification scripts (`verify-sync-flow.js`, `verify-communication-contract.js`, etc.) are all **static analysis only** — they check flow structure and SQL schema but never simulate runtime behavior.

---

## 7. Architecture Findings

### EdgeSyncService God class

`EdgeSyncService.java` — 1,503 lines, ~30 injected dependencies. Injects 15 repositories and 6 services, bypassing service-layer abstractions (e.g., `deviceRepository` alongside `deviceService`). Single `@Transactional` wraps entire bootstrap across 12+ entity types — one failure rolls back everything.

### Critical architecture items

| # | Finding | Location |
|---|---------|----------|
| **A1** | Bootstrap `@Transactional` spans entire payload — no savepoints, no partial commit. One constraint violation anywhere rolls back the whole 150-line method. | `EdgeSyncService.java:87` |
| **A2** | `applyEvents` `@Transactional` but catches `Exception` per event — if flush-time violation occurs, entire batch rolls back but `applied` counter reports false positives. | `EdgeSyncService.java:161-189` |
| **A3** | MQTT callback thread synchronously routes telemetry through DB reads/writes — single-point bottleneck that can violate MQTT keepalive. | `MqttSubscriberService.java:41-48` |
| **A4** | Zero structural validation on sync payloads — `Map<String, Object>` with manual `str()`/`numLong()` extraction, no JSON Schema, no `@Valid`. | `EdgeSyncService.java:91-149` |
| **A5** | `SoilHiveClient` holds `synchronized(tokenLock)` during HTTP OAuth token refresh — slow OAuth endpoint blocks all threads. | `SoilHiveClient.java:81-118` |
| **A6** | `PredictionScheduler` no overlap guard — if prediction runs take >60 min, next hourly cron fires concurrently. | `PredictionScheduler.java:33-52` |
| **A7** | No `@PreDestroy` cleanup for `MqttClient` — Paho TCP connection and thread pools leak on shutdown. | `MqttConfig.java:29` |
| **A8** | `SoilHiveClient` and `PredictionClient` use `SimpleClientHttpRequestFactory` — no connection pooling, new TCP connection per request. | `SoilHiveClient.java:33`, `PredictionClient.java:57` |

### Deprecated code that is actually live

`MqttPublisherService` is annotated `@Deprecated` but called on every `issueCommand` and `issueGatewayCommand` via `CommandService.bestEffortPublish()`. The deprecation is semantically incorrect — this is live code, not dead code. The command lifecycle status `SENT` means "published via MQTT", not "delivered to edge", creating ambiguous dual-path semantics.

---

## 8. Operational Robustness

### EUI normalization asymmetry (Critical)

Edge expands EUI-48 to EUI-64 via FFFE insertion (`flows.json` `normalizeGatewayDeviceEui`). Server only `trim().toUpperCase()` (`EdgeSyncService.java:1164`). Server-side lookups with raw 12-char EUIs will never match stored 16-char values.

### No command deduplication on edge (Critical)

The edge `sync-pending-split` node (`flows.json:5913`) maps server response to command objects and sends them directly to handlers with no `commandId` lookup. If the server reissues the same command (lost MQTT ACK, force-sync replay), the edge applies it again.

### Unbounded queues (Critical)

- `sync_outbox` — rows marked `delivered_at` but never deleted (both sides)
- `sync_inbox` — rows inserted per event, never pruned (cloud side)
- `command` history — PENDING/SENT commands accumulate indefinitely
- `chameleon_readings` — no UNIQUE constraint, repeated bootstrap duplicates rows

### 7-day token TTL with hourly refresh

Sync tokens last 7 days but the edge refreshes hourly. Over 7 days, ~168 active tokens per gateway with no server-side revocation. A stolen token is valid for up to 7 days.

### No retry/repair for 403

If a gateway is unlinked server-side, all sync operations (bootstrap, outbox, pending-commands) fail with 403 every cycle forever — never self-healing. No token refresh or re-link is triggered.

---

## 9. Cross-Reference to Refactor Spec

Every finding above maps to the refactor spec's findings catalog (`docs/specs/2026-05-03-sync-contract-refactor-design.md`):

| Review Finding | Spec Reference |
|---|---|
| Sync C1 (stale bootstrap gate) | Spec C1 — Bootstrap must carry snapshot epoch and per-resource version checks |
| Sync C2 (equal-version isStale) | Spec C2 — Treat equal-version writes as duplicates or conflicts |
| Sync C3 (cloud UI vs edge stomp) | Spec C3 — Cloud edits to edge-backed resources remain pending proposals |
| Sync C4 (silent exception swallowing) | Spec C6 / Spec A — Per-event statuses, edge only marks confirmed events |
| Sync C5-C8 (transport/403/tokens/retention) | Spec C7, C11, C12, C9 / Spec D |
| Schema D1 (SWT_1 CHECK) | Spec C4 — Canonical trigger metric vocabulary |
| Schema D2 (UUID format) | Spec H2 — Normalize identifiers at sync boundary |
| Schema D3-D13 (indexes, FK, types, soft-delete) | Spec H5, H6, H14 / Spec C, D |
| Architecture A1-A8 | Spec C5 / Spec E, F |
| Command handlers (0 idempotent) | Spec C8 / Spec B |
| Frontend normalization (dual casing) | Spec M5 |
| Test gaps (5-6 new tests) | Spec Phase 0 |

---

## 10. Consolidated Recommendations

| Priority | Action | Spec Phase |
|----------|--------|------------|
| **1** | Add `applied_commands` table to edge SQLite + dispatch-layer dedup. Covers all 28 command handlers without lease model complexity for the 11 DB-only handlers. | Phase 1 |
| **2** | Write 5-6 missing Phase 0 baseline tests before changing any behavior. | Phase 0 |
| **3** | Change `/edge/events` to return per-event statuses; mark only APPLIED/DUPLICATE events on edge. | Phase 1 |
| **4** | Fix dead `StregaValveState` bootstrap test (missing `@Test`). | Phase 0 |
| **5** | Decide canonical casing contract (camelCase or snake_case) before Phase 2 schema work. | Phase 2 |
| **6** | Add retention pruning for `sync_outbox`, `sync_inbox`, and command history. | Phase 3 |
| **7** | Add indexes for recurrent sync queries (inbox by source_node, pending commands by gateway+status). | Phase 3 |
| **8** | Add Node-RED `catch` nodes and explicit transport error handling to sync HTTP nodes. | Phase 1 |
| **9** | Add sync health visibility to edge SPA (rejected events, pending commands, token status). | Phase 3 |
| **10** | Add REST ACK endpoint as fallback to MQTT command ACKs. | Phase 1 |
| **11** | Split `EdgeSyncService` along module boundaries (orchestrator, event-apply, ownership, validator). | Phase 4 |
| **12** | Add structural validation to sync payloads (JSON Schema or typed DTOs replacing `Map<String, Object>`). | Phase 2 |
