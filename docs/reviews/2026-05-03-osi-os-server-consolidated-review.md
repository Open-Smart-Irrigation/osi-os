# OSI OS + OSI Server Consolidated Review Findings

Date: 2026-05-03

Scope:

- `osi-os` edge runtime, Node-RED flows, SQLite schema, React GUI, deploy/runtime helpers
- `osi-server` Spring backend, PostgreSQL/Flyway schema, command/sync services, MQTT/STOMP runtime, cloud React frontend, Terra Intelligence, Python prediction service

Source inputs:

- Multi-agent sync/schema/scalability review from 2026-05-03
- `osi-os/docs/specs/2026-05-03-sync-contract-refactor-design.md`
- `osi-os/docs/reviews/2026-05-03-sync-protocol-architecture-review.md`
- `osi-server/docs/reviews/2026-05-03-full-stack-code-review.md`
- `osi-server/docs/2026-05-03-system-architecture-review.md`
- Prior audit carry-forward from `osi-os/docs/reviews/2026-04-15-osi-os-full-audit.md`
- Prior audit carry-forward from `osi-server/docs/reviews/2026-04-15-osi-server-full-audit.md`

This document consolidates findings across both repos. It intentionally groups duplicate observations under shared root causes so the remediation backlog is easier to reason about.

---

## Executive Summary

The OSI architecture is fundamentally right for the current product shape: edge-first farm state, offline-capable gateways, REST sync for durable state transfer, and MQTT for telemetry/status. The happy path works for a single cloud instance and a small fleet.

The risk profile is concentrated in four areas:

1. **Silent correctness failures:** skipped sync events, optimistic edge ACKs, unsupported Chameleon commands, transport errors, stale bootstrap snapshots, and soft-delete/ownership gaps can produce wrong state without visible failure.
2. **Operational time bombs:** inbox/outbox rows, command history, telemetry, diagnostic readings, and unbounded repository queries can grow quietly until they degrade or crash production.
3. **Physical safety/security issues:** valve commands need local safety cutoffs and idempotency; cloud device ownership and WebSocket authorization need tighter tenant boundaries; prediction-service auth/path validation need hardening.
4. **Single-instance scaling assumptions:** STOMP, MQTT consumers, scheduler jobs, rate limiting, and command lifecycle state are not yet safe for horizontal cloud scaling.

The immediate priority is not a broad rewrite. The first slice should stop silent loss/replay: per-event sync results, selective edge outbox delivery marking, durable REST command ACK/NACK, edge command idempotency, and local valve safety timers.

---

## P0: Immediate Production Safety and Security

### P0-1: Edge valve commands need a local safety cutoff

Finding:

- An `OPEN_FOR_DURATION` command can leave irrigation hardware open indefinitely if ACKs are lost, flows crash, or the gateway reboots mid-actuation.
- The command lifecycle is currently too dependent on telemetry/ACK success and not enough on local hardware safety.

Impact:

- Physical irrigation hardware can remain open until manual intervention.

Required fix:

- Add a local edge watchdog that closes valves after `duration + grace_period`, independent of cloud ACK state.
- Add periodic reconciliation between local DB desired state and observed valve state.
- Make automated scheduler inserts and valve actions idempotent.

Related areas:

- `osi-os` `flows.json` valve command and scheduler paths
- `devices.target_state`
- `irrigation_events`

### P0-2: Sync events can be silently lost

Finding:

- Server event apply can catch per-event exceptions and still return HTTP success.
- Edge marks the whole submitted batch delivered on HTTP success.
- A skipped or failed event can therefore disappear from the edge outbox without being mirrored.

Impact:

- Cloud mirror can permanently miss edge state with no alert.

Required fix:

- `/api/v1/sync/edge/events` must return per-event status or fail whole batches.
- Edge must mark only `APPLIED` or `DUPLICATE` event UUIDs delivered.
- Rejected events must be quarantined with operator-visible health state.

Related areas:

- `osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- `osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncController.java`
- `osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`

### P0-3: REST-pulled commands can replay side effects

Finding:

- Commands are delivered by REST polling but completed primarily by MQTT ACK.
- If command application succeeds but MQTT ACK is lost, delayed, or blocked, the cloud can keep returning the command.
- Edge command routing does not persist command application by `commandId`.

Impact:

- Valve, configuration, and LoRaWAN downlink commands can be applied repeatedly.

Required fix:

- Add a durable REST ACK/NACK endpoint for commands.
- Lease pending commands with expiry and bounded response size.
- Persist applied command IDs on the edge and treat duplicate command IDs as idempotent duplicates.
- Add command TTL/expiry for time-sensitive commands.

Clarification:

- Some review inputs mention MQTT port `8883`; current repo context documents cloud MQTT as WSS on port 443. The failure mode is transport-path split, not a specific port.

### P0-4: Cloud authorization boundaries have high-risk gaps

Findings:

- Sync payloads trust user/device identifiers from the edge more than they should.
- Authenticated users may be able to unclaim edge-backed devices they do not own.
- WebSocket/STOMP device updates have historically weak or public tenant scoping.
- Bulk claim flows may allow sequential EUI enumeration without proof-of-possession.

Impact:

- Cross-tenant device mutation or telemetry subscription is possible if these paths remain unguarded.

Required fix:

- Bind every sync mutation to authenticated gateway EUI, linked user, claimed device, and soft-delete state.
- Add ownership checks before issuing `UNCLAIM_DEVICE` and other edge-backed commands.
- Require proof-of-possession such as claim PIN for bulk device claiming.
- Enforce authenticated, tenant-scoped WebSocket subscriptions.

### P0-5: Prediction service has direct security footguns

Findings:

- Python prediction service auth can be disabled silently when `PREDICTION_SERVICE_TOKEN` is unset.
- `experiment_id` can be passed to filesystem paths without strict allowlist validation.

Impact:

- Misconfigured deployments can expose internal prediction APIs.
- Path traversal can escape the intended evaluation store.

Required fix:

- Refuse startup when required internal auth secrets are missing.
- Validate path parameters with strict allowlist regex and resolved-path containment checks.

---

## P1: Sync and Data Correctness

### P1-1: Bootstrap lacks freshness gates

Finding:

- A stale full bootstrap from a restored gateway backup can overwrite newer incremental cloud mirror state.

Required fix:

- Add gateway database epoch or snapshot epoch.
- Add per-resource high-water marks or version checks.
- Reject stale bootstrap resources instead of blindly applying them.

Open design decision:

- Choose between gateway database epoch, server-issued bootstrap nonce, or per-aggregate high-water mark table.

### P1-2: Equal sync versions are accepted as fresh

Finding:

- Current staleness logic rejects only `incomingSyncVersion < currentSyncVersion`.
- Equal-version events can rewrite state unless they are proven duplicates.

Required fix:

- Treat equal version as duplicate only when event identity and canonical payload hash match.
- Otherwise reject or conflict-record the event.

Open design decision:

- Use canonical JSON hashing, preferably SHA-256 over RFC 8785-style canonical JSON, if hashes are compared across Java and edge JavaScript.

### P1-3: Cloud writes can stomp edge state at the same version

Finding:

- Some cloud UI writes mutate mirrored cloud state before edge confirmation.
- Concurrent edge events at the same version can silently win or lose.

Required fix:

- For edge-backed resources, cloud writes should become pending proposals/commands.
- Mirrored cloud state should advance from edge-applied events, not optimistic cloud mutation.

Open product decision:

- Define whether cloud UI shows optimistic pending state, edge-confirmed state only, or both.

### P1-4: Event deduplication has a race

Finding:

- Event processing checks existence before inserting inbox records.
- Concurrent `applyEvents` calls can both pass the check and double-process an event.

Required fix:

- Add a database unique constraint on `sync_inbox(event_uuid)`.
- Treat duplicate insert as idempotent duplicate success.

### P1-5: Event ordering is under-specified

Findings:

- Event batches have no gateway-scoped sequence number.
- Same-timestamp edge outbox rows can reorder.
- Cursor state can move in ways that hide gaps or reordered batches.

Required fix:

- Add gateway-scoped monotonic event sequence.
- Track cursor ranges and gaps.
- Sort edge outbox by a monotonic sequence, not only by occurrence timestamp.

### P1-6: Sync cursor writes can clobber progress

Finding:

- Bootstrap and event paths save partial `SyncCursor` objects with different fields populated.
- JPA merge can null unrelated cursor fields.

Required fix:

- Centralize cursor updates in a `SyncCursorService`.
- Load existing cursor row, mutate only intended fields, and preserve the rest.

### P1-7: Edge control-plane ACKs are optimistic

Finding:

- Edge command SQL paths initialize ACK as success before proving the DB update occurred.
- Missing rows, stale versions, or no-op updates can ACK success.

Required fix:

- Check affected row counts.
- Add stale-version predicates.
- ACK failure for missing resources, stale commands, and invalid payloads.

### P1-8: Edge HTTP transport errors are not surfaced reliably

Finding:

- Node-RED HTTP nodes can route DNS/TLS/network failures without a usable status code.
- Some paths can fall through as if sync succeeded.

Required fix:

- Route missing `statusCode`, connection errors, 401, and 403 through explicit failure paths.
- Do not mark events delivered or commands applied after transport failure.
- Set linked-account/sync health state for persistent auth failures.

### P1-9: Token refresh and auth failure handling are fragile

Findings:

- 403/Forbidden sync responses may not self-heal or trigger re-link guidance.
- Token refresh can race with outbox and pending-command polls.

Required fix:

- Centralize edge sync auth state.
- Serialize token refresh visibility relative to sync polls.
- Surface linked-account unhealthy states in the local GUI/API.

---

## P1: Schema and Contract Drift

### P1-10: Schedule trigger metric vocabulary differs

Finding:

- Cloud can emit `SWT_1`, while edge validation/check constraints may expect legacy `SWT_WM1` values.

Required fix:

- Define one canonical schedule trigger metric vocabulary.
- Add migration/normalization for legacy values on both edge and cloud.

### P1-11: Chameleon is split across deployed contracts

Findings:

- Server has Chameleon config fields and issues `SET_CHAMELEON_ENABLED` / `SET_CHAMELEON_CONFIG`.
- Edge main locally stores Chameleon readings but does not mirror `chameleonReadings` via bootstrap/outbox.
- Edge main lacks matching command handlers and device schema fields.

Required fix:

- Either merge full edge Chameleon support before exposing cloud commands, or gate commands by reported edge capability.
- Add Chameleon reading identity to avoid duplicate/collapse behavior.

### P1-12: UUID and EUI normalization differ

Findings:

- Edge can create 32-character hex UUIDs; cloud often uses dashed UUIDs.
- Edge can expand EUI-48 to EUI-64 using `FFFE`; server normalization may only trim/uppercase.

Required fix:

- Define canonical UUID and EUI formats at the sync boundary.
- Add normalization and rejection tests in both repos.

### P1-13: Device type and mirrored field catalogs drift

Findings:

- Device type vocabulary differs between edge and server catalog paths.
- Edge dendrometer history stores richer diagnostic fields than cloud mirror tables.
- Field geometry appears cloud-only, which is acceptable only if explicitly documented.

Required fix:

- Create a shared contract for device types, event types, command types, and mirrored field sets.
- Mark each resource as edge-backed or cloud-owned.

### P1-14: Delete/retention semantics differ by database

Finding:

- Some mirrored history tables use different FK delete behavior between edge and cloud, such as cascade versus set-null semantics.

Required fix:

- Define delete semantics per mirrored table.
- Align edge SQLite and cloud PostgreSQL behavior where data is intended to mirror.

### P1-15: Tombstone and soft-delete coverage is incomplete

Findings:

- Zone soft-delete does not clearly cascade or tombstone attached schedules.
- Device deletion lacks a dedicated `DEVICE_DELETED` event handler in the cloud event switch.
- Users lack a synced `deleted_at` concept, so user deletion cannot be represented consistently.

Required fix:

- Define tombstone events for every edge-backed aggregate.
- Add schedule/device/user delete tests across edge bootstrap, incremental events, and reconciliation.
- Ensure soft-deleted resources are excluded from active queries but remain available for sync dedup/history where needed.

### P1-16: Reconciliation detects too little and repairs nothing

Findings:

- Reconciliation is diagnostic-only.
- It can report counts and metadata while missing content drift such as wrong zone names or stale config fields.

Required fix:

- Add per-resource hashes or typed content checks for important mirrored resources.
- Define whether reconciliation only reports drift or can enqueue repair commands/events.
- Surface drift in sync health so operators can act.

---

## P2: Operational Time Bombs

### P2-1: Sync queues and command history grow without bound

Findings:

- Edge outbox rows are marked delivered, not pruned.
- Server inbox/dedup records have no clear retention.
- Command history and replay scans can grow indefinitely.

Required fix:

- Add retention windows and pruning jobs.
- Add indexes for pending/delivered/retry queries.
- Add queue depth, oldest pending age, retry histogram, and last failure metrics.

### P2-2: Pending/replay queries are unbounded

Findings:

- Pending commands can return all `PENDING` and `SENT` commands.
- Force-sync/replay can scan historical command sets in memory.
- Some device/gateway lookup paths load full tables per request.

Required fix:

- Add hard response limits.
- Use pagination or command leases.
- Add direct indexed repository queries.

### P2-3: Telemetry and JSONB storage needs a scale plan

Finding:

- Cloud JSONB telemetry is flexible, but fleet-scale queries will need retention, partitioning, and indexes.

Required fix:

- Add query-specific indexes for current dashboards/prediction paths.
- Plan native PostgreSQL partitioning, TimescaleDB, or another time-series storage strategy.
- Do not wait for bloat before adding retention.

### P2-4: Chameleon and MQTT telemetry can duplicate

Findings:

- Chameleon readings have no stable uniqueness contract.
- MQTT QoS 1 / duplicate uplinks can duplicate edge `device_data` rows if no frame-counter or idempotency key is used.

Required fix:

- Define idempotency keys per telemetry source.
- Use frame counter, timestamp plus payload hash, or device-specific reading identity.

### P2-5: Prediction and backfill jobs have unbounded or duplicate work paths

Findings:

- Prediction checkpoint backfill can call unbounded `findAll()`.
- Prediction run creation can race and create duplicate `RUNNING` rows.
- Prediction scheduler can fall behind or overlap without enough guards.

Required fix:

- Replace unbounded scans with count/page queries.
- Add unique constraints for run identity.
- Add overlap guards and bounded executor behavior.

### P2-6: Edge SQLite migrations are fragile under live drift

Findings:

- Edge schema evolution is embedded in Node-RED startup logic.
- Some table rebuilds use rename/copy patterns without an explicit transaction.
- Runtime migrations can swallow broad DDL errors and continue.
- Edge seed DBs and runtime-repaired schemas can diverge.

Required fix:

- Add executable migration tests against representative old edge schemas.
- Fail sync initialization loudly when required tables, columns, indexes, or triggers are missing.
- Keep seed DB schemas, runtime migrations, and deploy repair logic covered by a single schema parity check.

### P2-7: Timestamp, precision, and version defaults differ between edge and cloud

Findings:

- Edge stores many timestamps as SQLite `TEXT`; cloud uses timestamp types.
- Edge `datetime('now')` behavior needs explicit UTC guarantees.
- Some edge migrations set `sync_version = 1` while cloud defaults can be `0`.
- Chameleon resistance and diagnostic fields can differ in numeric precision.
- Dendrometer relationships differ between natural-key and surrogate-key references.

Required fix:

- Define timestamp format and timezone rules at the sync boundary.
- Normalize initial sync-version defaults.
- Align precision for mirrored numeric diagnostics.
- Document and test natural-key versus surrogate-key mapping for device history tables.

---

## P2: Edge Automation and Hardware Data Quality

### P2-8: Scheduler and actuation paths can duplicate or drift

Findings:

- A restart near scheduled cron time can double-fire irrigation.
- Disabling a zone may not close an open valve.
- Scheduler path may not update `devices.target_state` consistently.

Required fix:

- Add per-day schedule locks and idempotent irrigation event inserts.
- Close valves when disabling active zones.
- Reconcile target state after automated actuation.

### P2-9: Sensor fault handling can mask hardware failures

Findings:

- Watermark conversion can translate physically impossible frequencies into valid-looking dry readings.
- Dendrometer analytics can abort after stale data without a clear fallback.
- Unconfirmed valve downlinks may be assumed successful.

Required fix:

- Preserve hardware fault states distinctly from valid readings.
- Add fallback irrigation policy for stale analytics where product requirements allow.
- Distinguish command sent, downlink accepted, and actuator confirmed.

---

## P3: Horizontal Scaling Preconditions

### P3-1: STOMP/WebSocket broker state is instance-local

Finding:

- Simple in-memory STOMP broker means UI clients connected to one backend instance may not receive events processed by another.

Required fix:

- Move to an external STOMP broker relay or another cluster-safe event fanout design before adding backend replicas.

### P3-2: MQTT subscriber/consumer behavior is not cluster-defined

Finding:

- Multiple backend instances could duplicate processing unless MQTT subscription and message idempotency are explicitly designed.

Required fix:

- Use single-consumer semantics, shared subscriptions, or idempotent duplicate processing with durable keys.
- Move synchronous MQTT callback work to bounded worker queues.

### P3-3: Rate limiting is not cluster-safe and may misread proxy IPs

Findings:

- In-memory rate limiting will not coordinate across instances.
- Reverse-proxy IP handling can collapse all users into one bucket if forwarded headers are not configured correctly.

Required fix:

- Configure forwarded header strategy correctly.
- Move rate limit state to Redis or another shared store before horizontal scaling.

### P3-4: Schedulers and OAuth/token paths need concurrency hardening

Findings:

- Schedulers can overlap locally and across instances.
- Some OAuth token refresh logic can hold locks during slow HTTP calls.

Required fix:

- Add local and distributed single-flight guards where needed.
- Avoid holding synchronized locks across outbound network calls.

### P3-5: Runtime client lifecycle and connection pooling need hardening

Findings:

- MQTT client shutdown/cleanup may leak Paho resources if not explicitly closed.
- Some HTTP clients use simple request factories without connection pooling.

Required fix:

- Add lifecycle cleanup for MQTT clients.
- Use pooled HTTP clients for frequently-called internal/external services.
- Add timeout and backpressure settings where synchronous clients remain.

---

## P4: Frontend, API Shape, and Developer Ergonomics

### P4-1: Frontend shape normalization is brittle

Findings:

- Cloud APIs use modern DTO shapes while shared/ported frontend components often expect edge legacy snake_case shapes.
- `farming.ts` domain models are duplicated across repos.
- Large normalization functions are carrying cross-repo schema drift manually.

Required fix:

- Introduce shared contracts or generated DTOs.
- Keep a small view-model adapter boundary per frontend.
- Avoid spreading legacy shape compatibility through components.

### P4-2: Large frontend components block maintainability

Findings:

- Terra `App.tsx` and admin prediction pages are large multi-concern components.
- Several data-fetching effects lack abort/cancel handling.
- Feature-level error boundaries are missing or leak raw stack traces in production.

Required fix:

- Extract hooks and subcomponents around map lifecycle, drawing state, prediction runs, and charts.
- Add `AbortController` or cancellation guards for fetch effects.
- Gate stack traces to development and add page/card-level error boundaries.

### P4-3: WebSocket client lifecycle is fragile

Findings:

- Reconnect paths can reuse expired tokens.
- Subscriptions can leak or duplicate updates over long sessions.
- WebSocket updates can bypass HTTP cache state.

Required fix:

- Use a token getter during reconnect.
- Store and dispose STOMP subscription handles.
- Reconcile WebSocket updates with the frontend data cache.

### P4-4: Prior UI/build audit items remain relevant

Carry-forward findings:

- `osi-os` React auth context can remain stale after 401.
- `osi-server` frontend auth context can remain stale after 401.
- Bundle sizes are high for field/mobile dashboards.
- Some legacy demo app files/docs remain in `osi-os`.

Required fix:

- Notify auth context on token clearing.
- Audit bundle size after large UI refactors.
- Remove or clearly archive legacy frontend paths.

### P4-5: Test coverage misses several sync and architecture regressions

Findings:

- At least one intended bootstrap test exists without an active test annotation.
- Some tests still exercise deprecated/live MQTT publish behavior without clarifying the intended command lifecycle.
- Edge verification scripts are mostly static analysis and do not simulate runtime sync failures.
- Baseline tests are missing for stale bootstrap, equal-version conflicts, missing target command failure, Chameleon command handling, and Node-RED transport error paths.

Required fix:

- Add the missing test annotation or delete/rewrite the dead test.
- Add runtime-style tests for mixed event apply results and transport failures.
- Add command lifecycle tests that reflect the chosen REST ACK/lease design.

---

## P4: Prediction Service Robustness

### P4-6: Prediction API validation is incomplete

Findings:

- Unknown catalog codes can raise `KeyError` as HTTP 500.
- Engine `ValueError` can propagate as HTTP 500.
- Evaluation scoring can raise `StopIteration`.
- Pydantic models lack physical range constraints for several numeric fields.
- Missing weather temperatures can be substituted silently with hardcoded defaults.

Required fix:

- Convert expected validation failures to 4xx responses.
- Add Pydantic field constraints.
- Log and surface synthetic-data substitution.

### P4-7: Prediction payload and checkpoint coupling need scale boundaries

Findings:

- Large prediction payloads can stress the small VPS.
- Java and Python checkpoint field lists are manually coupled.
- Sequential blocking prediction calls can create backlog.

Required fix:

- Bound payload size.
- Version checkpoint schemas.
- Move toward bounded async per-zone execution.

---

## Cross-Cutting Refactor Themes

### Theme 1: Make sync explicit and versioned

The sync protocol needs a versioned contract for events, commands, resource identities, schema versions, and error semantics. It should not rely on `Map<String,Object>` extraction and convention-only payload shapes.

### Theme 2: Separate delivery from application

HTTP 200 does not mean an event was applied. REST fetch does not mean a command was applied. MQTT publish success does not mean the edge received or executed a command. The lifecycle should distinguish delivered, accepted, applied, duplicate, rejected, retryable, expired, and terminal failure.

### Theme 3: Bound and observe all queues

Every queue-like table or flow needs retention, max response size, retry/backoff, failure reason, and metrics. This applies to sync inbox/outbox, command history, MQTT worker queues, prediction jobs, and diagnostic reading ingestion.

### Theme 4: Preserve edge-first semantics

For edge-backed resources, cloud writes should be pending proposals until the edge applies them. Cloud-only resources should be explicitly labeled as cloud-owned.

### Theme 5: Do not scale horizontally until instance-local state is removed

STOMP, MQTT consumption, rate limiting, scheduler locks, and command leases must be cluster-safe before multiple cloud replicas handle production sync/command traffic.

---

## Recommended Remediation Order

### Slice 1: Stop silent sync loss

- Add per-event statuses to `/edge/events`.
- Make edge mark only applied/duplicate event UUIDs delivered.
- Add inbox unique constraint and duplicate handling.
- Add tests for skipped, duplicate, rejected, stale, and equal-version events.

### Slice 2: Make commands safe

- Add command leases with bounded polling.
- Add REST ACK/NACK.
- Persist applied command IDs on edge.
- Add local valve safety cutoff and command TTL.
- Make edge ACKs verify affected rows and stale versions.

### Slice 3: Fix security boundaries

- Enforce sync ownership by authenticated gateway/user/device.
- Fix device unclaim ownership.
- Harden WebSocket/STOMP tenant scoping.
- Require prediction service auth at startup.
- Validate path parameters and device claim proof-of-possession.

### Slice 4: Lock schema contracts

- Define canonical device types, event types, command types, UUID/EUI formats, schedule metric names, and Chameleon identity.
- Add contract tests across edge SQLite/flows, server Flyway/entities, and TypeScript types.
- Resolve Chameleon edge/server parity and `SWT_1` migration.

### Slice 5: Add retention and observability

- Prune delivered inbox/outbox rows.
- Add indexes and bounded queries.
- Add queue depth, oldest age, retry, rejection, and auth failure metrics.
- Add prediction backfill pagination and run uniqueness constraints.

### Slice 6: Prepare for horizontal scale

- Externalize STOMP broker and rate limiter state.
- Define MQTT consumer semantics.
- Move MQTT callback DB work to worker queues.
- Add distributed scheduler locks.

---

## Notes on Severity Normalization

- Findings that can directly cause physical harm, cross-tenant access, data loss, or service crash are P0.
- Findings that can corrupt mirrored state or block reliable sync are P1.
- Findings that will degrade storage, query performance, or operational recovery are P2.
- Findings that block horizontal scaling are P3.
- Findings that primarily affect maintainability, UI robustness, or developer velocity are P4 unless they create direct security or data-integrity risk.

Some source reviews used `Critical`, `High`, and `Medium`; this document remaps those severities into remediation priority so related work can be planned in coherent slices.
