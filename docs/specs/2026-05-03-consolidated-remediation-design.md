# Consolidated Remediation Design

**Date:** 2026-05-03
**Scope:** `osi-os` and `osi-server`
**Source reviews:**

- [2026-05-03 OSI OS + OSI Server Consolidated Review Findings](../reviews/2026-05-03-osi-os-server-consolidated-review.md)
- [2026-05-03 Sync Protocol & Architecture Review](../reviews/2026-05-03-sync-protocol-architecture-review.md)
- `osi-server/docs/reviews/2026-05-03-full-stack-code-review.md`

**Integrated source spec:** [Sync Contract and Schema Refactor Design](2026-05-03-sync-contract-refactor-design.md)
**Status:** Authoritative umbrella design spec for remediation planning

---

## Overview

OSI's current edge-first architecture is sound for one cloud instance and a small fleet. OSI OS owns operational farm state, OSI Server mirrors that state, REST handles durable sync, and MQTT carries edge-to-cloud telemetry/status.

The failures identified by the reviews are concentrated in silent sync loss, command replay, local actuation safety, tenant/security boundaries, schema drift, unbounded operational data, and single-instance runtime assumptions. This document turns those findings into implementation-ready workstreams.

---

## Goals

1. Stop silent data loss in edge-to-cloud sync.
2. Stop repeated physical side effects from replayed commands.
3. Add local valve safety independent of cloud/network ACKs.
4. Tighten tenant, ownership, and internal-service security boundaries.
5. Stabilize the edge/cloud schema and payload contract.
6. Add retention, bounded queries, indexes, and sync health observability.
7. Remove single-instance assumptions before horizontal scaling.
8. Improve frontend and prediction robustness where failures affect correctness or operations.

---

## Non-Goals

- Do not replace REST sync with MQTT command subscriptions in the first remediation slice.
- Do not add new cloud-to-edge command transports such as gRPC or WebSocket in this remediation.
- Do not rewrite all Node-RED flows in one pass.
- Do not split all of `EdgeSyncService` before behavior is protected by tests.
- Do not introduce a code-generation toolchain before JSON Schema contracts are proven by tests.
- Do not change the edge-first source-of-truth rule for edge-backed farms.
- Do not make cloud-only Terra field geometry edge-backed unless product requirements change.

---

## Current Architecture Snapshot

### Edge

`osi-os` runs on a Raspberry Pi gateway with Node-RED, ChirpStack, SQLite, and the React GUI. The edge stores flattened, strongly typed local state in SQLite and applies operational changes locally first.

Primary sync and schema surfaces:

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- `scripts/verify-sync-flow.js`
- bundled seed databases under `database/`, `web/react-gui/`, and `conf/*/usr/share/db/`

### Cloud

`osi-server` runs a Spring backend with PostgreSQL and Flyway migrations. It mirrors edge-backed resources and also owns cloud-only features such as Terra Intelligence field geometry when those resources are not explicitly edge-backed.

Primary sync and schema surfaces:

- `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- `backend/src/main/java/org/osi/server/sync/EdgeSyncController.java`
- `backend/src/main/java/org/osi/server/command/CommandService.java`
- `backend/src/main/resources/db/migration/`
- MQTT subscriber/router services under `backend/src/main/java/org/osi/server/mqtt/`

### Protocols

- Edge pushes bootstrap and incremental events over REST.
- Edge pulls pending cloud commands over REST.
- Edge sends telemetry and command ACKs over MQTT.
- Cloud MQTT command publishing still exists in deprecated code paths, but the edge does not subscribe to cloud command topics in the documented current architecture.

---

## Workstream 1: Physical Actuation Safety

### Problem

Valve and actuator paths can assume successful physical execution based on command dispatch or ACK flow. An `OPEN_FOR_DURATION` command can leave a valve open if the flow crashes, the gateway reboots, the ACK path fails, or downstream RF delivery is not confirmed.

### Target Behavior

- Every duration-based valve open has a local safety deadline.
- The edge closes the valve after `duration + grace_period` even if ACK, cloud sync, or scheduler state is unhealthy.
- Zone disable operations close active valves for that zone.
- Scheduler-triggered irrigation is idempotent per zone and schedule occurrence.
- `devices.target_state`, actuator logs, and observed state are periodically reconciled.

### Design

Add an edge-local actuation safety layer in `flows.json` backed by SQLite state. The layer sits below cloud-originated commands and local scheduler decisions so all valve opens pass through the same safety path.

Recommended state:

- `valve_safety_locks`
  - `lock_id TEXT PRIMARY KEY`
  - `device_eui TEXT NOT NULL`
  - `zone_id TEXT`
  - `command_id TEXT`
  - `opened_at TEXT NOT NULL`
  - `must_close_at TEXT NOT NULL`
  - `closed_at TEXT`
  - `close_reason TEXT`
  - `created_at TEXT NOT NULL`

Runtime rules:

- The safety monitor runs every 30 seconds.
- Maximum expected close overshoot is 29 seconds plus local command execution time.
- Duration-based irrigation shorter than the monitor cadence must still write a safety lock and may close on the next monitor tick; UI/API validation should prefer durations of at least 60 seconds.
- On Node-RED startup, before accepting new commands, query `valve_safety_locks` for `closed_at IS NULL`. If `must_close_at <= now()`, issue a close immediately. If `must_close_at > now()`, leave the lock active and let the normal monitor close it.
- If local clock health is unknown after reboot, close any open valve safety lock conservatively before accepting new duration commands. This avoids applying stale server timestamps when the Pi clock has not synchronized.

### Acceptance Criteria

- A gateway reboot during an open valve window still results in close on startup or monitor recovery.
- Disabling a zone with an active valve issues a close and records the close reason.
- A failed ACK path does not prevent safety close.
- The safety monitor cadence and maximum overshoot are documented and verified.
- Tests or verification scripts prove the watchdog table and flow nodes exist.

---

## Workstream 2: Durable Event Sync

### Problem

The edge can mark events delivered after an HTTP success even when the server skipped or failed individual events. Bootstrap and incremental event processing also lack strong freshness, ordering, and conflict semantics.

### Target Behavior

- Event delivery and event application are separate states.
- Server returns per-event status for every submitted event.
- Edge marks only `APPLIED` and `DUPLICATE` events delivered.
- `RETRYABLE_ERROR` stays pending with backoff.
- `REJECTED` is quarantined and surfaced in sync health.
- Stale bootstrap snapshots cannot overwrite newer incremental state.
- Duplicate or equal-version events cannot rewrite state unless proven identical.

### API Design

Extend `/api/v1/sync/edge/events` with a versioned response contract:

- Request header: `X-OSI-Sync-Protocol: 2`
- Response field: `eventResults`

Response envelope:

```json
{
  "eventResults": [
    {
      "eventUuid": "d4fe4b8f2c584d1ca8c39dce37e6ec90",
      "status": "APPLIED",
      "retryable": false,
      "reason": null,
      "resourceType": "ZONE",
      "resourceId": "zone-uuid",
      "appliedSyncVersion": 12
    }
  ]
}
```

`eventResults` contains one result per submitted event, keyed by `eventUuid`. Submission order should be preserved for debugging, but the edge must match by `eventUuid`.

`appliedSyncVersion` is the server's mirror `sync_version` for the affected resource after applying the event. The edge does not use it to overwrite local source-of-truth state; it is diagnostic/high-water information for sync health and reconciliation.

Allowed statuses:

- `APPLIED`
- `DUPLICATE`
- `REJECTED`
- `RETRYABLE_ERROR`

### Server Requirements

- Step 0: add a unique constraint on `sync_inbox(event_uuid)`.
- Treat duplicate event UUID insertion as idempotent duplicate success.
- Validate ownership before mutation.
- Require explicit `syncVersion` for versioned resources after legacy compatibility windows.
- Reject equal-version writes unless event UUID and payload hash match a known duplicate.
- Preserve cursor fields when updating cursor state.

Payload hash rule:

- The server computes a per-event payload hash after parsing the event.
- Hash input is a canonical event payload projection, excluding transport metadata such as batch wrapper, auth context, and receipt timestamp.
- Canonicalization uses sorted object keys, UTF-8, no whitespace, ISO-8601 UTC timestamps, stable numeric formatting, and explicit treatment of null versus absent fields as defined in `docs/contracts/sync-schema/README.md`.
- All runtimes that compute hashes must pass shared test vectors before their hashes are trusted. Initial implementation may keep hashing server-side only.

Cursor preservation example:

- If bootstrap updates `lastFullBackfillAt` or a snapshot cursor, it must not null or rewind an already advanced incremental `lastEventAt` / `lastEventUuid`.
- If an event batch updates incremental event cursor fields, it must not null `lastFullBackfillAt`.

### Bootstrap Freshness

Bootstrap must not blindly overwrite newer incremental state.

Recommended cloud high-water table:

- `sync_resource_watermarks`
  - `gateway_eui TEXT NOT NULL`
  - `resource_type TEXT NOT NULL`
  - `resource_id TEXT NOT NULL`
  - `highest_sync_version BIGINT NOT NULL`
  - `last_event_uuid TEXT`
  - `payload_hash TEXT`
  - `updated_at TIMESTAMPTZ NOT NULL`
  - unique key on `(gateway_eui, resource_type, resource_id)`

The per-resource watermark table is part of the design. The remaining bootstrap decision is whether to add a gateway-level database epoch to detect full DB replacement, SD-card swaps, or restored backups on top of per-resource watermarks.

### Edge Requirements

- Keep current behavior for protocol v1 until edge v2 is deployed.
- For protocol v2, mark only `APPLIED` and `DUPLICATE` UUIDs delivered.
- Persist rejection reason and last retryable failure.
- Expose unhealthy sync state when rejected events exist.

### Acceptance Criteria

- Mixed batch with one rejected event leaves that event pending or quarantined on edge.
- Duplicate event UUID applies no side effects on second delivery.
- Stale bootstrap after newer incremental event does not overwrite cloud mirror.
- Equal version with different payload is rejected or conflict-recorded.
- Cursor updates preserve unrelated cursor fields.

---

## Workstream 3: Command Lease, ACK, and Idempotency

### Problem

Commands are pulled by REST but completed primarily by MQTT ACK. If application succeeds and ACK is lost, the same command can be returned again and re-applied. Some command handlers produce physical side effects, downlinks, GPIO writes, system commands, provisioning calls, or duplicate logs on replay.

### Target Behavior

- Pending command reads are bounded and lease-based.
- REST ACK/NACK is the durable command lifecycle transition.
- MQTT command ACK can remain telemetry, but is not the only completion mechanism.
- Edge stores applied command IDs and skips duplicate application.
- Commands have expiry for time-sensitive operations.

### Server Design

Command lifecycle:

- `PENDING`
- `LEASED`
- `ACKED`
- `NACKED`
- `EXPIRED`
- `CANCELLED`

Command fields:

- `lease_owner_gateway_eui`
- `leased_at`
- `lease_expires_at`
- `attempt_count`
- `acknowledged_at`
- `ack_result`
- `last_error`
- `expires_at`
- `effect_key`

Leasing:

- `GET /api/v1/sync/gateways/{gatewayEui}/pending-commands?limit=50`
- v2 clients receive leased commands.
- Default lease duration is `max(poll_interval * 3, 120s)`, configurable.
- Maximum lease duration is 5 minutes unless a command type explicitly requires longer.
- Maximum attempt count defaults to 5. After that, commands move to `NACKED` or `EXPIRED` with `last_error`.
- Old v1 clients do not receive `LEASED` commands. If a lease expires without ACK, the command returns to `PENDING` so a v1 client can still see it during mixed rollout.

Durable ACK:

- `POST /api/v1/sync/gateways/{gatewayEui}/command-acks`

ACK payload:

```json
{
  "acks": [
    {
      "commandId": "cmd-uuid",
      "result": "APPLIED",
      "appliedAt": "2026-05-03T12:00:00Z",
      "appliedSyncVersion": 42,
      "duplicate": false,
      "reason": null
    }
  ]
}
```

ACK response:

```json
{
  "results": [
    {
      "commandId": "cmd-uuid",
      "status": "ACKED",
      "terminal": true,
      "leasedAgain": false
    }
  ]
}
```

The batch ACK endpoint avoids adding HTTP request nodes to every command handler. The edge writes ACK rows locally and a single command-ACK flush flow posts them.

### Edge Design

Edge state:

- `applied_commands`
  - `command_id TEXT PRIMARY KEY`
  - `command_type TEXT NOT NULL`
  - `applied_at TEXT`
  - `result TEXT NOT NULL`
  - `ack_sent INTEGER NOT NULL DEFAULT 0`
  - `last_ack_attempt_at TEXT`
  - `expires_at TEXT`
  - `effect_key TEXT`

Dispatch rules:

- If `command_id` is already applied, do not run the handler again.
- Send duplicate ACK with the prior result.
- Command handlers must verify target resource existence and affected row counts.
- Time-sensitive commands are rejected after expiry when clock health is trusted.
- If clock health is unknown or skew exceeds a configured threshold, reject time-sensitive commands until NTP or server-time offset is healthy.

Effect keys:

- `effect_key` is generated by the server and carried in the command payload.
- Exact command replay is deduped by `command_id`.
- Cross-command replay of the same physical effect is deduped by `effect_key`.
- For scheduled irrigation, use `irrigation:{zone_id}:{schedule_id}:{scheduled_for}`.
- For manual one-off valve commands, use `manual:{device_eui}:{command_id}` so intentional repeated manual actions are allowed.
- Force-sync replay must preserve the original `effect_key`.

### Acceptance Criteria

- Same command ID delivered twice applies once.
- Replayed physical effect with a preserved `effect_key` does not create duplicate irrigation history.
- Lost MQTT ACK does not cause replay after REST ACK.
- Missing target resource produces NACK, not success.
- Expired `OPEN_FOR_DURATION` command is not applied when clock health is valid.
- Pending-command response has a hard limit.
- Lease expiry after edge-side apply does not create duplicate irrigation history when the gateway reconnects.

---

## Workstream 4: Ownership and Security Boundaries

### Problem

Some sync, command, WebSocket, device claim, and internal-service paths trust caller-provided identifiers or deployment configuration too much.

### Target Behavior

- Every edge sync mutation is constrained by authenticated gateway, linked user, claimed device, and soft-delete state.
- Cloud UI command endpoints verify the caller owns or is authorized for the target gateway/device/zone.
- WebSocket/STOMP subscriptions are authenticated and tenant-scoped.
- Device claiming requires proof-of-possession once that product decision is closed.
- Prediction service refuses insecure startup and validates filesystem-bound path parameters.

### Edge Ownership Service

Add an `EdgeOwnershipService` in `osi-server`. This is a security boundary, not just a helper.

Checks:

- gateway token maps to gateway EUI
- gateway is linked to cloud user
- device belongs to gateway or linked user
- zone belongs to linked user/farm
- resource is not soft-deleted unless the event is a tombstone/restore path

Use from:

- bootstrap apply
- event apply
- pending command reads
- command ACK
- user/device command controllers
- unclaim/replay/force-sync paths
- `/api/v1/devices/claim-bulk`

Tombstone validation:

- A tombstone for a known resource is accepted only if the resource is currently or historically owned by the authenticated gateway/user graph.
- A tombstone for an unknown resource may be recorded in the sync inbox/tombstone ledger for deduplication, but must not delete or mutate unrelated active state.
- Restore events must prove ownership against either current active ownership or the tombstoned ownership record.

### WebSocket Hardening

- Require authenticated STOMP `CONNECT`.
- Reconnect logic must use a token getter, such as `() => getAccessToken()`, so reconnect attempts do not reuse expired tokens.
- Reject reconnects with expired tokens and call the auth-expired path.
- Move device update subscriptions toward tenant-scoped destinations such as `/topic/users/{userUuid}/devices/{deviceEui}/telemetry`.
- Until destinations are migrated, subscription interceptors must authorize legacy `/topic/devices/{deviceEui}` by device ownership before allowing the subscription.

### Internal Service Hardening

- Prediction service must fail startup if `PREDICTION_SERVICE_TOKEN` is unset or empty.
- `experiment_id` must match `^[A-Za-z0-9_-]{1,64}$`.
- Filesystem paths must be resolved and verified under the configured store root.

### Standalone Security/Robustness Fixes

These are small fixes with no architectural dependency and should not wait for the full ownership service:

- `SoilHiveClient` missing `expires_in` default should be conservative, e.g. 3000 seconds, not 86400 seconds.
- `ZoneSoilProfileService` / `AsyncConfig` must handle `RejectedExecutionException`, with a rejection handler such as `CallerRunsPolicy` or an explicit logged retry path.
- `DeviceController.canClaimGatewayDevices()` must include `SUPER_ADMIN` where intended.
- Reverse proxy forwarded-header handling must be configured so rate limiting uses the real client/gateway identity rather than the Caddy proxy IP.

### Acceptance Criteria

- Gateway token cannot mutate another user's zone/device.
- Authenticated user cannot unclaim a device outside their ownership boundary.
- WebSocket subscription to another user's device is rejected.
- WebSocket reconnect uses a fresh token and reports auth expiry.
- Prediction service does not start without required internal auth token.
- Path traversal inputs are rejected with 4xx.

---

## Workstream 5: Schema and Payload Contract

### Problem

Edge and cloud schema models are diverging in identifiers, enums, timestamps, device types, Chameleon fields, dendrometer diagnostics, soft-delete behavior, and frontend DTO shapes.

### Target Behavior

- Edge and cloud agree on canonical payload names and values.
- Contract drift is caught by tests before deploy.
- Edge SQLite seed DBs, runtime migrations, server Flyway migrations, Java models, and TypeScript types are checked against the same contract.

### Contract Format

Use checked-in JSON Schema files and tests, not generation tooling.

Recommended location:

- `docs/contracts/sync-schema/`
- `docs/contracts/sync-schema/README.md`
- `docs/contracts/sync-schema/events.schema.json`
- `docs/contracts/sync-schema/commands.schema.json`
- `docs/contracts/sync-schema/resources.schema.json`

The open ownership decision is where this directory ultimately lives: `osi-os`, mirrored into `osi-server`, or a shared repo/package. Until that is closed, keep the canonical draft in `osi-os` docs and copy it into `osi-server` tests only as a pinned fixture.

### Contract Contents

The contract defines:

- event type names
- command type names
- device type names
- schedule trigger metric names
- UUID normalization rules
- EUI normalization rules
- timestamp format and timezone
- resource ownership: edge-backed or cloud-owned
- tombstone support per resource
- Chameleon reading identity
- dendrometer diagnostic mirror fields
- FK/delete semantics for mirrored history tables
- soft-delete filter semantics for edge-backed mirrored resources

Contract decisions:

- Canonical trigger metrics use `SWT_1` / `SWT_2` / `SWT_3`; legacy `SWT_WM1` values are accepted only through migration/normalization.
- Canonical gateway EUIs are uppercase EUI-64 strings; EUI-48 input is expanded with the documented `FFFE` rule before lookup.
- Sync UUIDs are normalized to one canonical string form at API boundaries.
- Edge-backed mirrored resources with `deleted_at` columns must have global JPA soft-delete filtering, and standard list queries must exclude soft-deleted rows.

Initial Chameleon reading identity:

- Primary identity is `(device_eui, recorded_at, f_cnt)` when `f_cnt` exists.
- Fallback identity is `(device_eui, recorded_at, payload_hash)` when no frame counter is available.
- Cloud must not collapse two rows with the same timestamp but different frame counter or payload hash.

Initial dendrometer mirror fields:

- `position_um`
- `position_raw_um`
- `adc_raw`
- `adc_ch0v`
- `adc_ch1v`
- `dendro_ratio`
- `mode`
- `saturation_state`
- `bat_v`
- `bat_pct`
- `is_valid`
- `is_outlier`

### Verification Mechanism

- Extend `scripts/verify-sync-flow.js` or add `scripts/verify-sync-contract.js`.
- Parse `flows.json` for command type literals in the Route Command node and downstream handler lists.
- Compare extracted command/event names with JSON Schema enums.
- Inspect seed SQLite schemas for required tables/columns/indexes.
- Inspect server Flyway/entity metadata where feasible from tests.

### Acceptance Criteria

- Contract tests fail if edge `flows.json` accepts a command not defined in the contract.
- Contract tests fail if server emits a schedule metric edge cannot accept.
- Contract tests fail if seed DBs lack required sync tables/columns/indexes.
- Chameleon commands are either capability-gated or supported by edge main.
- Field geometry is explicitly marked cloud-owned unless sync support is added.

---

## Workstream 6: Retention, Indexing, and Observability

### Problem

Queue-like tables and telemetry/history tables grow without clear bounds. Several status and polling paths need indexes, bounded responses, and operator-visible failure signals.

### Target Behavior

- Delivered sync rows are retained for a defined diagnostic window and pruned.
- Pending/replay queries are bounded and indexed.
- Telemetry has retention/partitioning appropriate to fleet scale.
- Sync health exposes actionable state.

### Retention Design

Retention policies:

- Edge delivered outbox: retain 14-30 days, configurable.
- Edge inbox/dedup: retain longer than maximum replay window.
- Cloud sync inbox: retain longer than maximum gateway replay window.
- Commands: retain completed commands for audit window; expire stale pending commands.
- Chameleon diagnostic rows: retain or dedupe according to defined reading identity.
- Telemetry: define short-term high-resolution retention and long-term aggregate retention.

Retention mechanisms:

- Edge pruning runs as a Node-RED maintenance flow at a low cadence, such as daily.
- Cloud pruning starts as Spring scheduled jobs while production remains single-instance.
- Before horizontal scaling, cloud pruning jobs must use a distributed lock, PostgreSQL advisory lock, or external scheduler so multiple replicas do not prune concurrently.

Indexes:

- `sync_inbox(event_uuid)` unique.
- `sync_inbox(source_node, processed_at DESC)` where `source_node` is the gateway/source node identifier used by inbox queries.
- command lookup by gateway and status/lease expiry.
- edge outbox lookup by delivered state, retry state, and sequence/time.
- telemetry indexes or partitions for dashboard/prediction query windows.

### Observability Design

First observability surface:

- `GET /api/v1/admin/sync-health`
- Supports gateway-scoped query by `gatewayEui`.
- Supports pagination/limit for fleet-wide views, default limit 100.
- Must use indexed or pre-aggregated counters and must not full-scan queue tables for dashboard requests.

Returned data:

- pending event count by gateway
- oldest pending event age
- rejected event count
- retry count histogram
- pending command count by gateway
- oldest pending command age
- 401/403 linked-account failure
- MQTT worker queue depth where available
- prediction job backlog
- last failure reason

Prometheus/Micrometer export can be added later. The first pass should avoid adding heavy monitoring infrastructure to the constrained production VPS.

### Acceptance Criteria

- Delivered sync tables do not grow without bound.
- Pending command and sync status queries use indexes.
- A poison event surfaces unhealthy sync state.
- Operators can see oldest pending age and last failure reason.
- Admin sync-health endpoint remains bounded under fleet-wide use.

---

## Workstream 7: Single-Instance Scaling Readiness

### Problem

Several runtime paths assume one backend instance: in-memory STOMP broker, in-memory rate limiting, MQTT consumer behavior, scheduled jobs, and command lifecycle transitions.

### Target Behavior

- Horizontal scale is blocked until shared state or duplicate-safe processing exists.
- Multiple backend instances cannot double-apply events, double-lease commands, or split WebSocket delivery.

### Design

Preconditions before multiple production backend replicas:

- Correct reverse proxy forwarded-header handling so rate limiting uses real client/gateway identity.
- Shared/distributed rate limiter state.
- Durable command leasing in PostgreSQL.
- Distributed locks or single-flight guards for scheduled jobs.
- MQTT callback work moved to bounded worker queues.
- MQTT telemetry ingestion is duplicate-safe through idempotency keys; single-consumer routing is optional when idempotency is proven.
- UI fanout uses an external STOMP broker relay or a lower-effort cluster-safe fanout design such as PostgreSQL LISTEN/NOTIFY if it satisfies latency/load requirements.

External STOMP broker migration is a high-effort infrastructure change and needs its own infrastructure design before production rollout.

### Acceptance Criteria

- Two backend instances cannot apply the same event twice.
- Two backend instances cannot lease the same command.
- UI clients receive device updates regardless of which backend processes MQTT telemetry.
- Rate limits apply per real client/user/gateway, not per proxy IP or per JVM only.
- Scheduled prediction/dendro jobs cannot overlap across instances.

---

## Workstream 8: Frontend and API Shape Stabilization

### Problem

Cloud frontend normalization translates modern backend DTOs back into edge legacy shapes so shared/ported components work. Types are duplicated across repos, fetch lifecycles are fragile, and large components hide state-management bugs.

### Target Behavior

- Each frontend has a narrow API adapter that converts backend DTOs into a stable view model.
- Shared fields are contract-tested or generated after the contract stabilizes.
- Fetch effects are cancellable.
- Feature-level error boundaries prevent one card/page section from taking down the full dashboard.
- Production error boundaries do not show stack traces.

### Design

Near-term:

- Extract a cloud frontend `usePageData` hook following Terra Intelligence's `useLiveData` pattern: `AbortController`, request-version refs, and stale-response suppression.
- Apply the hook first to page-level fetches most exposed to stale navigation responses.
- Bound the snake/camel cleanup to high-impact surfaces first: `frontend/src/services/api.ts`, `frontend/src/types/farming.ts`, dashboard cards, and prediction/admin pages.
- Keep adapters, but shrink them around explicit view models.
- Add feature-level error boundaries around dashboard cards and prediction/admin sections.
- Gate stack traces to development mode only.
- Fix hardcoded `2026-04-11` fallback date in `terra-intelligence/src/moistureModel.ts:706`.

Longer-term:

- Move shared DTO/view model definitions into a shared contract package or generated types after schema contracts stabilize.
- For the two frontends inside `osi-server`, first consider a simple shared `types.ts` or `view-models.ts` in a common frontend location before investing in generated packages.

### Acceptance Criteria

- A malformed card payload does not crash the entire dashboard.
- Production UI does not render raw stack traces.
- Reconnect/fetch stale responses do not overwrite newer state after navigation.
- Type drift between edge and cloud DTOs is caught by contract tests or shared types.

---

## Workstream 9: Prediction and Analytics Robustness

### Problem

Prediction, dendrometer analytics, and scheduler paths include validation gaps, unbounded scans, duplicate-run races, sequential blocking work, and manually coupled checkpoint schemas.

### Target Behavior

- Prediction API returns 4xx for expected validation failures, not 500.
- Internal auth is mandatory.
- Path parameters are safe.
- Backfill and scheduled jobs are bounded and non-overlapping.
- Prediction runs are unique per zone/date.
- Large payloads and checkpoint fields have explicit limits/contracts.
- Dendrometer weather-quality gaps are tracked instead of silently becoming valid zero-rainfall inputs.

### Backend Design

- Replace unbounded `findAll()` backfill paths with count/page queries.
- Add a uniqueness constraint for prediction run identity, such as `(zone_id, run_date)`.
- Add scheduler overlap guards with database uniqueness where possible and PostgreSQL advisory locks or ShedLock for scheduled job single-flight.
- Add explicit `DendroScheduler` overlap guard.
- Bound executor queues and handle rejection with retry or explicit failure state.
- Store a `rainfall_quality` flag beside dendro measurements and schedule a backfill/reconciliation path for weather API recovery.

### Prediction Service Design

- Add Pydantic numeric range constraints.
- Convert `KeyError`, expected `ValueError`, and missing evaluation records to 4xx responses.
- Log synthetic weather substitution and include quality metadata where relevant.
- Default `CHRONOS_2_ENABLED` to false on constrained deployments unless explicitly enabled.
- Version checkpoint schema through JSON Schema under `docs/contracts/prediction-schema/`, with Java/Python tests that fail when either side changes without updating the contract.

### Acceptance Criteria

- Backfill can process large run tables without loading all rows.
- Concurrent prediction start attempts produce one run row.
- Unknown catalog codes return 422.
- Empty forcing data returns 422.
- Missing auth token prevents service startup.
- Dendro scheduler cannot overlap.
- Checkpoint schema changes fail tests unless Java/Python contracts are updated together.

---

## Workstream 10: Sync Service Decomposition

### Problem

`EdgeSyncService` mixes request orchestration, bootstrap apply, event apply, entity CRUD, gateway migration, cursor tracking, inbox deduplication, command status, telemetry mirrors, ownership checks, and reconciliation. The current shape makes correctness tests hard to write and broad transactions harder to reason about.

### Target Behavior

- Sync behavior is split into focused modules with clear interfaces.
- Transaction boundaries match the unit of work being applied.
- Ownership validation is explicit and shared by bootstrap and event paths.
- Cursor/inbox logic is independently testable before broader service refactoring.

### Design

Target modules:

- `EdgeSyncOrchestrator`: validates request context and coordinates high-level flows.
- `BootstrapApplyService`: handles full snapshot apply with snapshot freshness checks.
- `EventApplyService`: validates and applies incremental events.
- `SyncInboxService`: owns deduplication, event status, and inbox retention.
- `SyncCursorService`: owns cursor updates, high-water marks, and gap handling.
- `CommandLeaseService`: owns pending command leases and ACK/NACK transitions.
- `EdgeOwnershipService`: validates gateway, linked user, device, and zone ownership.
- `SyncSchemaValidator`: validates payload structure, enum values, UUIDs, EUIs, and versions.
- `TelemetryMirrorService`: handles sensor, dendrometer, Chameleon, environment, and irrigation history mirrors.

Transaction boundaries:

- Bootstrap commits by resource type and page. Control-plane resources can use small resource groups; data-plane history uses bounded pages.
- Event application isolates each event or a small resource group.
- Cursor and inbox updates are atomic with the event status they represent.
- Command ACK transitions are atomic with command status updates.

Ordering:

- Extract `SyncInboxService` and `SyncCursorService` early if Phase 0 tests are impractical against the monolith.
- Full service decomposition waits until first correctness fixes are covered by tests.

### Acceptance Criteria

- Tests can exercise event staleness without bootstrapping the full sync service graph.
- Ownership validation is called for every sync mutation.
- Cursor updates preserve unrelated cursor fields.
- A failed bootstrap resource page reports which resource failed.

---

## Rollout Plan

### Phase 0: Decisions and Baseline Tests

Close blocking decisions:

- gateway-level epoch model for restored DB detection
- JSON Schema contract ownership/location
- claim proof-of-possession mechanism

Add failing tests or verification cases for:

- unique `sync_inbox(event_uuid)` duplicate handling
- skipped event in 200 response
- duplicate event UUID
- stale bootstrap after newer event
- equal sync version with different payload
- repeated command ID and repeated effect key
- missing target resource command
- `SWT_1` schedule command on edge
- Chameleon command on edge main
- Node-RED transport error path
- valve safety timeout and startup recovery
- cross-tenant unclaim attempt
- prediction service missing auth token

### Phase 1a: Immediate Safety and Security

- prediction service missing-token startup failure
- prediction `experiment_id` path validation
- `sync_inbox(event_uuid)` unique constraint
- valve safety watchdog and startup recovery
- edge `applied_commands` table
- basic edge command deduplication by `command_id`
- standalone quick fixes: SoilHive token default, async rejection handler, `SUPER_ADMIN` claim authorization, forwarded headers for rate limiting

### Phase 1b: Sync and Command Protocol

- per-event sync results
- selective edge outbox delivery marking
- command ACK outbox and REST batch ACK
- command leases, expiry, max attempts
- effect-key preservation for physical commands

### Phase 2: Ownership and Security Boundaries

- sync ownership service
- unclaim/device command ownership checks
- WebSocket tenant authorization and reconnect token refresh
- claim proof-of-possession implementation after decision closure

### Phase 3: Schema Contracts

- JSON Schema contract files
- schema/payload parity tests
- Chameleon parity/gating
- trigger metric, UUID, EUI, tombstone, and delete-semantics fixes

### Phase 4: Operations and Prediction Robustness

- retention jobs
- indexes
- bounded queries
- admin sync-health endpoint
- prediction pagination and uniqueness
- dendro scheduler/weather-quality fixes

### Phase 5a: Sync Service Decomposition

- extract `SyncInboxService`
- extract `SyncCursorService`
- split event/bootstrap/command modules after tests protect behavior

### Phase 5b: Frontend Stabilization

- `usePageData` hook
- bounded API normalization cleanup
- feature error boundaries
- shared view-model types for `osi-server` frontends

### Phase 5c: Horizontal Scale Readiness

- external/shared rate limiter state
- cluster-safe UI fanout design
- MQTT worker queues
- distributed scheduler locks

---

## Verification Strategy

### `osi-os`

Existing checks:

- `node scripts/verify-sync-flow.js`
- `node scripts/verify-communication-contract.js`
- `scripts/check-mqtt-topics.sh`

New checks:

- `node scripts/verify-command-safety.js`
  - verifies `applied_commands`
  - verifies `valve_safety_locks`
  - verifies command ACK flush flow
  - verifies safety monitor startup path
- extend `verify-sync-flow.js` to check per-event delivery marking and transport-error branches

### `osi-server`

- sync service tests for per-event result, duplicate event, stale bootstrap, equal-version conflict, cursor preservation, and ownership rejection
- command service tests for lease, ACK/NACK, expiry, max attempts, and duplicate handling
- security tests for WebSocket subscription authorization and device unclaim ownership
- prediction service tests for auth startup, path validation, and 4xx validation failures
- admin sync-health endpoint tests for queue depth, oldest pending age, rejected events, pagination, and last failure reason

### Cross-Repo

- contract parity tests for command types, event types, device types, trigger metrics, UUID/EUI normalization, and Chameleon fields
- mixed-batch sync simulation as a mocked integration test first: one applied event, one rejected event, edge outbox keeps only the rejected event pending, and cloud mirror reflects only the applied event
- later Docker Compose integration test once protocol shape is stable

---

## Open Decisions

### Must Resolve Before Implementation

1. **Gateway database epoch:** Is a gateway-level epoch needed in addition to per-resource watermarks, and is it edge-generated or server-issued?
2. **Contract ownership:** Keep JSON Schema contracts in `osi-os`, mirror them into `osi-server`, or move them into a shared repository/package?
3. **Claim proof-of-possession:** Claim PIN, QR code, local gateway approval, or another device-bound proof?

### Defaults For Now

4. **Cloud pending UX:** Default to showing both proposed and edge-confirmed state with clear visual distinction.
5. **Conflict storage:** Default to hard reject equal-version conflicts until quarantine tables are justified by operations.
6. **Telemetry scale path:** Default to native PostgreSQL partitioning before TimescaleDB or separate TSDB.
7. **Chameleon rollout:** Default to gate server commands by edge capability until edge main fully supports them.

---

## Recommended First Slice

The first implementation slice should stop immediate physical and data-loss risk:

1. Add prediction service auth/path hotfixes.
2. Add `sync_inbox(event_uuid)` uniqueness and duplicate handling.
3. Add edge valve safety watchdog for duration-based opens.
4. Add edge `applied_commands` table and basic command deduplication.
5. Add per-event sync results and selective edge outbox delivery marking.

This slice does not require the full schema contract, horizontal scaling work, or full `EdgeSyncService` decomposition.
