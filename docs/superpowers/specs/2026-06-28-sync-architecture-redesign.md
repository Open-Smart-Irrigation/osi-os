# Edge-to-Cloud Sync Architecture Redesign

Date: 2026-06-28
Status: Proposed
Decision: Canonical history sync with a link-gated structural outbox

This spec supersedes the earlier draft that treated the whole data plane as a
simple telemetry pipeline. The final design combines:

- Approach 1 as the target architecture: history is synced from canonical
  tables, not from `sync_outbox`.
- Approach 2's raw-table cursor mechanics: append-only raw rows are tailed by
  monotonic local `id`, not by `recorded_at`.
- Approach 3's phased rollout: run old and new paths in parallel until coverage
  is proven, then remove triggers table by table.

## 1. Goals

1. Keep edge and server mirrors in sustained parity for all edge-authored data.
2. Ensure a hub that has never linked to OSI Server creates zero
   `sync_outbox` rows.
3. Preserve offline-first behavior: `/data/db/farming.db` remains canonical and
   complete while unlinked or network-offline.
4. Remove high-volume history payload duplication from `sync_outbox`.
5. Make first-link backfill, ongoing tail sync, parity checks, repair, retry,
   and rollback use one coherent model.
6. Keep REST as the only sync transport. MQTT remains edge-to-cloud telemetry,
   heartbeat, status, and ACK only.

## 2. Non-Goals

- Do not make the cloud authoritative for edge history.
- Do not introduce server-initiated calls into the edge.
- Do not add runtime plugins or dynamic sync schema loading.
- Do not replace the existing pending-command or command-ACK paths.
- Do not overwrite or reseed `/data/db/farming.db` on a provisioned Pi.

## 3. Current Constraints

The current edge uses unconditional SQLite triggers to mirror history rows into
`sync_outbox`. This creates duplicate payloads for `device_data`,
`chameleon_readings`, `dendrometer_readings`, derived daily rows, zone daily
rows, and irrigation events.

Bootstrap is bounded by recent windows and row limits, so it is not a full
history mechanism. The server already contains event-v2 compatibility code for
existing firmware; that path must remain during rollout.

The schema has mixed row identity:

- `device_data`, `chameleon_readings`, and `dendrometer_readings` have local
  `id INTEGER PRIMARY KEY AUTOINCREMENT` and non-unique time indexes.
- `dendrometer_daily` and `zone_daily_recommendations` have unique natural keys.
- `zone_daily_environment` has unique `(zone_id, date)` but no `id`.
- `irrigation_events` currently has a local integer `id` but no persisted
  `event_uuid`.
- Server `chameleon_readings` intentionally has no unique constraint because a
  stable frame-level key was not previously available.

These facts drive the design: raw tailing must use local row id, derived rows
need dirty-key tracking, and server idempotency cannot rely only on existing
target-table constraints.

## 4. Architecture

```
EDGE (/data/db/farming.db is canonical)

  Structural/config tables
    -> link-gated sync_outbox
    -> POST /api/v1/sync/edge/events

  Raw append-only history
    -> sync_history_cursors by table and local id
    -> POST /api/v1/sync/edge/history/batches

  Derived/upsert history
    -> initial scan plus sync_history_dirty_keys
    -> POST /api/v1/sync/edge/history/batches

  Daily parity
    -> sync_history_segments row count + payload hash
    -> POST /api/v1/sync/edge/history/manifests
    -> targeted repair batches

SERVER (mirror, edge-authoritative for edge data)

  Existing structural event receiver remains
  New history ingest writes through edge_history_row_index
  Reconciliation reports event health, history cursor health, and parity state
```

The design has four planes with hard boundaries:

| Plane | Data | Edge mechanism | Server behavior |
|---|---|---|---|
| Structural outbox | Zones, devices, schedules, gateway location, config tombstones | Link-gated triggers into `sync_outbox` | Existing event-v2 receiver and watermarks |
| Raw history | `device_data`, `chameleon_readings`, `dendrometer_readings` | Id-cursor uploader, no outbox triggers | Idempotent history ingest by `history_key` |
| Derived history | `dendrometer_daily`, `zone_daily_environment`, `zone_daily_recommendations` | Full scan plus dirty-key tracker | Edge-wins upsert by natural key |
| Parity and repair | Segment manifests and targeted rows | Daily row count + payload hash compare | Request/accept repairs, quarantine extras |

## 5. Link State Rules

There are two different offline cases and the system must treat them
differently.

### 5.1 Never Linked / Explicitly Unlinked

- No `sync_outbox` rows are created.
- No pending-command polling runs.
- No history jobs run.
- No new derived-history dirty keys are created; peer-specific dirty keys are
  removed when unlink clears the account identity.
- Canonical history continues accumulating locally.
- First link runs structural bootstrap and full history backfill.

### 5.2 Linked But Network Offline

- Structural outbox rows may accumulate because a peer exists.
- Raw history is not duplicated; it remains only in canonical tables.
- Derived dirty keys may accumulate, but one row key only has one dirty-key row.
- Cursors do not advance until server ACK.
- Sync resumes without data loss when network returns.

### 5.3 Link Gate

Add a small link-state table:

```sql
CREATE TABLE IF NOT EXISTS sync_link_state (
  peer_node TEXT PRIMARY KEY,
  linked INTEGER NOT NULL DEFAULT 0,
  server_url TEXT,
  cloud_user_id TEXT,
  gateway_device_eui TEXT,
  updated_at TEXT NOT NULL
);
```

Structural triggers must include a `WHEN` guard equivalent to:

```sql
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
```

This guard is acceptable on low-volume structural triggers. Raw-history
triggers are removed entirely and therefore do not pay a hot-path guard cost.

## 6. Data Classification

### 6.1 Structural Outbox

Keep these in `sync_outbox`, but only when linked:

| Aggregate | Reason |
|---|---|
| `ZONE` | Mutable state, tombstones, sync versions |
| `DEVICE` | Assignment, unassignment, unclaim, flags |
| `SCHEDULE` | Mutable schedule state |
| `GATEWAY_LOCATION` | Gateway config/location state |
| Future config aggregates | Only if they are mutable state with tombstones |

Bootstrap establishes the current baseline for any pre-link structural state.
Pre-link structural changes must not be replayed as events, because there was no
peer when the changes happened.

### 6.2 Raw Append-Only History

Remove these from `sync_outbox`:

| Table | Cursor | History key |
|---|---|---|
| `device_data` | local `id` | `DEVICE_DATA|<gateway_eui>|<edge_id>` |
| `chameleon_readings` | local `id` | `CHAMELEON_READING|<gateway_eui>|<edge_id>` |
| `dendrometer_readings` | local `id` | `DENDRO_READING|<gateway_eui>|<edge_id>` |

Do not use `recorded_at` as the tail cursor. Late or out-of-order uplinks can
arrive with old timestamps but new local ids; an id cursor catches them.

### 6.3 Derived / Upsert History

Target state: remove these from `sync_outbox` after the dirty-key tracker is
proven:

| Table | Dirty row key | Notes |
|---|---|---|
| `dendrometer_daily` | `DENDRO_DAILY|<deveui>|<date>` | Updates to old days must enqueue the same key again |
| `zone_daily_environment` | `ZONE_ENVIRONMENT|<zone_uuid>|<date>` | No local `id`; do not use id-cursor templates |
| `zone_daily_recommendations` | `ZONE_RECOMMENDATION|<zone_uuid>|<date>` | Updates to old days must enqueue the same key again |

The dirty-key table is internal sync state, not an outbox. It is bounded by
unique row key and only active when linked. First-link and relink backfills scan
the canonical tables directly, so unlinked hubs do not need dirty-key rows.

### 6.4 Irrigation Events

Move `irrigation_events` to history sync only after adding a persisted
`event_uuid`:

```sql
ALTER TABLE irrigation_events ADD COLUMN event_uuid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_irrigation_events_event_uuid
  ON irrigation_events(event_uuid);
```

Backfill existing rows once:

```text
event_uuid = 'irrig-' || <origin_gateway_eui> || '-' || printf('%012d', id)
```

Until `event_uuid` is present and verified, keep irrigation events on the
existing event path during rollout.

## 7. Edge Schema

### 7.1 History Cursors

```sql
CREATE TABLE IF NOT EXISTS sync_history_cursors (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'tail',
  snapshot_high_id INTEGER,
  last_acked_id INTEGER,
  last_acked_key TEXT,
  backfill_started_at TEXT,
  backfill_completed_at TEXT,
  last_batch_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name, phase)
);
```

Raw tables use `last_acked_id`. Derived tables use `last_acked_key` only for
scan progress during full backfill; ongoing changes are driven by dirty keys.

### 7.2 Dirty Keys

```sql
CREATE TABLE IF NOT EXISTS sync_history_dirty_keys (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name, row_key)
);
```

Triggers on derived/upsert tables use `INSERT ... ON CONFLICT DO UPDATE` so a
row recomputed ten times still occupies one dirty-key row.

### 7.3 Segment Cache

```sql
CREATE TABLE IF NOT EXISTS sync_history_segments (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  covered_max_id INTEGER,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (peer_node, table_name, segment_key)
);
```

Segment keys are usually `device_eui|YYYY-MM-DD`, `zone_uuid|YYYY-MM-DD`, or a
monthly bucket for older low-change ranges.

### 7.4 Quarantine

```sql
CREATE TABLE IF NOT EXISTS sync_history_quarantine (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  history_key TEXT NOT NULL,
  payload_hash TEXT,
  reason TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (peer_node, table_name, history_key)
);
```

Permanent row-level rejections are quarantined so one bad row does not block the
whole stream. Retryable failures must not advance cursors.

### 7.5 Required Indexes

Existing raw-table primary keys support `WHERE id > ? ORDER BY id LIMIT ?`.
Keep the existing `(deveui, recorded_at)` and `(zone_id, date)` indexes for
range reads, parity buckets, diagnostics, and GUI history.

Add missing derived indexes only if query plans show table scans during parity
or dirty-key lookup.

## 8. History Keys and Payload Hashes

Every history row sent to the server has:

- `historyKey`: stable identity for the edge row.
- `naturalKey`: human-readable diagnostic key.
- `payloadHash`: SHA-256 over canonical payload serialization.
- `payload`: explicit table-specific JSON payload.

| Table | `historyKey` | `naturalKey` |
|---|---|---|
| `device_data` | `DEVICE_DATA|gateway_eui|edge_id` | `deveui|recorded_at|edge_id` |
| `chameleon_readings` | `CHAMELEON_READING|gateway_eui|edge_id` | `deveui|recorded_at|f_port|f_cnt|edge_id` |
| `dendrometer_readings` | `DENDRO_READING|gateway_eui|edge_id` | `deveui|recorded_at|edge_id` |
| `dendrometer_daily` | `DENDRO_DAILY|deveui|date` | same |
| `zone_daily_environment` | `ZONE_ENVIRONMENT|zone_uuid|date` | same |
| `zone_daily_recommendations` | `ZONE_RECOMMENDATION|zone_uuid|date` | same |
| `irrigation_events` | `IRRIGATION_EVENT|event_uuid` | same |

Using edge local id for raw append-only rows avoids timestamp collisions and
does not require destructive deduplication of existing field data. Server
queries can still use natural timestamps for analysis; the history key is for
sync identity.

Canonical hash rules:

1. The payload is built from an explicit ordered column list per table.
2. Timestamps are normalized to UTC ISO-8601 milliseconds.
3. Missing values and SQL `NULL` serialize as JSON `null`.
4. Booleans serialize as `true` or `false`, not `0` or `1`.
5. Numeric values serialize from the database value without locale formatting.
6. Object keys are sorted before hashing.

The hash contract must be covered by shared golden-vector tests in `osi-os` and
`osi-server` before enabling repair.

## 9. Edge Sync Flow

### 9.1 Link

On successful `/auth/local-sync`:

1. Store server URL, sync token, cloud user id, and gateway EUI.
2. Set `sync_link_state('cloud').linked = 1`.
3. Run structural bootstrap.
4. Start history backfill jobs for all enabled history tables.
5. Resume structural outbox delivery.
6. Resume pending-command polling.

### 9.2 Unlink

On unlink:

1. Set `sync_link_state('cloud').linked = 0`.
2. Stop history jobs.
3. Stop outbox delivery and pending-command polling.
4. Clear peer-specific cursors and dirty keys only if the account identity is
   no longer known.
5. Never delete canonical history.

If the same account is known on relink, reuse peer-specific cursors and verify
with parity. If not, start full backfill from the beginning. Full backfill is a
safe fallback, not the default optimization path.

### 9.3 Raw Backfill and Tail

For each raw table:

```sql
SELECT *
  FROM <table>
 WHERE id > ?
 ORDER BY id ASC
 LIMIT ?;
```

Cursor advancement rules:

- Cursor advances only after the server transaction commits and returns
  `APPLIED`, `DUPLICATE`, or `QUARANTINED` for a contiguous prefix.
- Cursor does not advance past retryable server or network failures.
- Backfill captures `snapshot_high_id = max(id)` when a job starts. Reaching
  that id marks backfill complete; later rows are tail sync.
- The worker processes one bounded batch per tick and interleaves tables so
  `device_data` cannot starve smaller streams.

### 9.4 Derived Backfill and Dirty Sync

Initial backfill scans canonical derived tables by natural key. Ongoing linked
changes use dirty-key rows.

Dirty-key processing:

1. Select the oldest pending dirty keys, bounded by table and batch size.
2. Re-read the current canonical row for each key.
3. Send the current row state and payload hash.
4. On ACK, mark the dirty key delivered or delete it.
5. If the row no longer exists, send a delete/tombstone repair only for tables
   where deletion is meaningful. Otherwise quarantine and surface the issue.

This avoids relying on `date` cursors for old-day recomputes.

### 9.5 Bootstrap

Bootstrap becomes structural/config baseline sync only after the history
pipeline is live and server capabilities are confirmed.

During rollout, the server must continue accepting old bootstrap telemetry
sections from older edge firmware. New firmware should stop sending history in
bootstrap once `history_sync_v1` is active.

## 10. Server Design

### 10.1 History Row Index

Add a server-side index table:

```sql
CREATE TABLE edge_history_row_index (
  gateway_eui VARCHAR(32) NOT NULL,
  table_name VARCHAR(80) NOT NULL,
  history_key VARCHAR(180) NOT NULL,
  natural_key VARCHAR(240),
  payload_hash VARCHAR(64) NOT NULL,
  server_table VARCHAR(80) NOT NULL,
  server_row_id VARCHAR(80),
  conflict_state VARCHAR(30),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gateway_eui, table_name, history_key)
);
```

This avoids forcing every server history table to grow edge-specific columns
immediately, while giving parity and repair one stable interface.

### 10.2 Batch Endpoint

`POST /api/v1/sync/edge/history/batches`

Request envelope:

```json
{
  "protocolVersion": 1,
  "gatewayDeviceEui": "0016C001F11715E2",
  "batchId": "uuid",
  "tableName": "device_data",
  "phase": "backfill",
  "cursor": { "fromId": 100, "toId": 600 },
  "rows": [
    {
      "historyKey": "DEVICE_DATA|0016C001F11715E2|123",
      "naturalKey": "A84041...|2026-06-28T10:00:00.000Z|123",
      "payloadHash": "64-hex",
      "payload": {}
    }
  ]
}
```

Processing:

1. Authenticate with the sync token.
2. Validate gateway ownership of every device or zone referenced by the row.
3. Validate the table-specific payload contract.
4. Look up `(gateway_eui, table_name, history_key)` in
   `edge_history_row_index`.
5. If no index row exists, apply the row to the mirror table and create the
   index row.
6. If the same hash already exists, return `DUPLICATE`.
7. If the key exists with a different hash, update the edge-sourced mirror row
   from the edge payload, record `conflict_state='EDGE_OVERWROTE_SERVER'`, and
   return `UPDATED`.
8. If ownership fails or payload is permanently invalid, return
   `REJECTED_PERMANENT`.
9. If a server dependency is temporarily unavailable, return
   `RETRYABLE_ERROR`.

The server must commit table writes and index writes in one transaction before
ACKing cursor advancement.

### 10.3 Explicit Table Mappers

The endpoint envelope can be generic, but payload handling must be explicit per
table. Do not accept arbitrary columns silently. Adding a new history column
requires:

1. Edge payload builder update.
2. Server mapper update.
3. Shared hash golden vector update.
4. Contract verifier update.

This prevents schema drift where the edge believes a field is mirrored but the
server silently drops it.

### 10.4 Backward Compatibility

Keep these existing server paths during rollout:

- `/api/v1/sync/edge/events` handling old telemetry event types.
- `/api/v1/sync/edge/bootstrap` accepting old history arrays.

Compatibility paths can be deprecated only after all supported OSI OS images
advertise `history_sync_v1`.

## 11. Parity and Repair

Parity is part of the MVP. Row-count-only parity is not enough for the stated
goal because it misses same-count/different-payload divergence.

### 11.1 Segment Manifests

The edge periodically sends:

```json
{
  "gatewayDeviceEui": "0016C001F11715E2",
  "generatedAt": "2026-06-28T03:00:00.000Z",
  "segments": [
    {
      "tableName": "device_data",
      "segmentKey": "A84041CAFECAFE01|2026-06-27",
      "rowCount": 288,
      "payloadHash": "64-hex"
    }
  ]
}
```

Segment generation should be incremental where possible. The daily job checks
recent windows first, then rotates through older windows over time.

### 11.2 Comparison Outcomes

| Case | Detection | Repair |
|---|---|---|
| Edge has row/server missing | Edge segment count or hash differs | Server asks edge to upload missing range or whole segment |
| Server has extra edge-sourced row | Server index has key absent from edge segment after confirmation | Quarantine first, then prune edge-sourced mirror row after second confirmation |
| Same key, different payload | Same history key, different hash | Edge payload overwrites server mirror and conflict is recorded |
| Structural tombstone missing | Config parity or event replay detects server active row | Edge re-emits structural tombstone event |

The server never writes repaired history back to the edge. Edge remains
authoritative.

### 11.3 Repair Endpoint

Use the same batch ingest contract for repair:

`POST /api/v1/sync/edge/history/batches` with `phase='repair'`.

The difference is operational context, not payload format.

## 12. Migration Plan

### Phase 0: Server Compatibility

1. Add `edge_history_row_index`.
2. Add history batch and manifest endpoints.
3. Add capability advertisement: `history_sync_v1`.
4. Keep old events and bootstrap behavior unchanged.
5. Add server tests for duplicate, update, rejection, ownership, and conflict
   paths.

### Phase 1: Edge Schema, No Behavior Change

1. Add link state, history cursor, dirty-key, segment, and quarantine tables.
2. Add `irrigation_events.event_uuid` and backfill legacy rows.
3. Do not drop old triggers yet.
4. Update verifiers to assert the new tables exist in both Pi profiles.

### Phase 2: Shadow History Upload

1. Run raw history uploader in shadow while old telemetry triggers still feed
   `sync_outbox`.
2. Server dedupes old event path and new history path using the history index
   plus existing watermarks.
3. Run parity in diagnostic-only mode.
4. Do not mark any residual outbox rows delivered yet.

### Phase 3: Coverage Audit and Field Recovery

Before removing or pruning history outbox rows, audit each table:

1. Confirm canonical table coverage by row count and timestamp/id range.
2. Compare residual history outbox rows to canonical rows.
3. If outbox contains older rows missing from canonical tables, recover them on
   a DB copy first, validate, then import into canonical tables.
4. Keep structural outbox rows untouched.

This phase exists because past field failures left `sync_outbox` with older
history rows than the canonical history tables.

### Phase 4: Remove Raw-History Outbox Triggers

After server capability and coverage are proven:

1. Drop `device_data`, `chameleon_readings`, and `dendrometer_readings` outbox
   triggers.
2. Keep history uploader as the sole raw-history path.
3. Mark only audited and superseded raw-history outbox rows delivered.

### Phase 5: Move Derived and Irrigation Rows

1. Enable dirty-key triggers for derived history.
2. Run in parallel with existing derived outbox triggers.
3. Prove parity for derived tables.
4. Drop derived-history outbox triggers.
5. Move irrigation events only after `event_uuid` is populated and verified.

### Phase 6: Narrow Bootstrap and Enable Repair

1. New firmware stops sending history arrays in bootstrap.
2. Server still tolerates old arrays from old firmware.
3. Parity repair changes from diagnostic-only to automatic for
   edge-present/server-missing and hash divergence.
4. Server-extra pruning remains two-confirmation or operator-approved.

## 13. Rollback

- Before Phase 4, rollback is just disabling the history uploader; old outbox
  triggers still work.
- After Phase 4, rollback can recreate raw triggers, but cloud gaps are repaired
  by rerunning full history backfill.
- Never roll back by restoring an old database over `/data/db/farming.db`.
- Any migration that rebuilds a parent table referenced by history child tables
  must fence the swap with `PRAGMA foreign_keys=OFF` and restore
  `PRAGMA foreign_keys=ON` after the final drop.
- The history uploader never mutates canonical history except for the explicit
  field-recovery import approved during Phase 3.

## 14. Performance Requirements

- Raw ingest hot path must not execute sync triggers.
- Raw upload queries must be `WHERE id > ? ORDER BY id LIMIT ?`.
- Default batch size: 250 to 500 rows, server-advertised and edge-configurable.
- Pi 4/400/3/2 profiles may use smaller batches and longer intervals.
- Uploader must run one bounded batch per tick and yield to local ingest.
- Server may return `Retry-After`, `recommendedBatchSize`, and
  `minIntervalMs`.
- Parity jobs must read segment cache or bounded date windows, not full history
  every night.

## 15. Acceptance Criteria

### Offline and Link State

- A never-linked hub can ingest sensor data for days and `sync_outbox` remains
  empty.
- Linking later uploads all canonical history, not just bootstrap windows.
- Unlinking stops outbox delivery, pending-command polling, and history jobs.
- Linked network-offline operation accumulates only bounded structural outbox
  rows and bounded derived dirty keys.

### Raw History

- Raw history outbox triggers are absent in the final target.
- Backfill ships every canonical raw row exactly once logically, with duplicate
  retries returning `DUPLICATE`.
- Late uplinks with old `recorded_at` and new local `id` are uploaded.
- Killing Node-RED mid-backfill resumes from the last ACKed id.

### Derived History

- Old-day recomputes of daily rows are delivered through dirty keys.
- `zone_daily_environment` sync does not assume an `id` column.
- Derived parity detects missing rows, extra rows, and hash divergence.

### Server Robustness

- Server ingest is idempotent by `(gateway_eui, table_name, history_key)`.
- Same-key/different-hash rows update the edge-sourced mirror and record a
  conflict.
- Ownership failures reject rows without advancing retryable batches.
- Old firmware event/bootstrap sync continues to work during rollout.

### Migration

- Existing large history outbox backlogs are not blindly discarded.
- If outbox rows contain history missing from canonical tables, recovery is done
  from a DB copy first.
- Structural outbox rows are preserved throughout migration.

### Verification

- `node scripts/verify-sync-flow.js` checks link-gated structural triggers,
  removed raw-history triggers, new history tables, and bootstrap narrowing.
- `node scripts/verify-profile-parity.js` passes for bcm2712 and bcm2709.
- Server tests cover history batches, parity manifests, repair, and backward
  compatibility.

## 16. Test Strategy

### Edge Unit and SQLite Tests

- Link gate suppresses all `sync_outbox` writes while unlinked.
- Raw cursor query catches late old-timestamp rows by id.
- Cursor advances only after ACKed contiguous results.
- Dirty-key trigger coalesces repeated derived updates.
- `zone_daily_environment` derived sync works without an id column.
- `irrigation_events.event_uuid` backfill is deterministic and unique.
- Quarantine lets later rows continue.

### Server Tests

- Batch replay with same rows returns duplicates and creates no extra mirror
  rows.
- Same history key and different hash updates the edge-sourced mirror.
- Chameleon rows dedupe through `edge_history_row_index` even though the target
  table has no unique natural constraint.
- Ownership denial returns permanent rejection.
- Old `/edge/events` telemetry still works for old firmware.
- Old bootstrap telemetry arrays are accepted or ignored according to advertised
  capabilities.

### End-to-End Tests

- Fresh unlinked Pi: one hour of sensor data, zero outbox rows.
- Offline for 30 days, then link: full history appears on server.
- Network loss mid-backfill: resume without gaps.
- Derived daily row recomputed for an old date: server receives updated row.
- Server row deleted manually: parity requests repair and edge reuploads.
- Server row modified manually: hash divergence is detected and edge overwrites.
- Server extra edge-sourced row: quarantine first, prune only after confirmation.

### Performance Tests

- 1M `device_data` rows: raw batch query remains under the target latency using
  primary-key id cursor.
- Backfill under active ingest does not cause excessive WAL growth.
- Daily parity manifest is proportional to active segments, not total history.
- Pi 4 and Pi 5 payload files stay byte-for-byte aligned.

## 17. Open Decisions Before Coding

1. Exact canonical hash serialization and golden-vector fixture format.
2. Server-extra pruning policy: automatic after two confirmations or
   operator-approved.
3. Whether same-account relink can be proven by `/auth/local-sync` response so
   cursors can be retained confidently.
4. Initial full-history backfill horizon. Default is all local canonical
   history; any retention cap changes the parity promise and needs a separate
   decision.
5. Whether derived-history dirty keys are implemented in the first slice or
   derived tables remain on the event path for one transitional release.

## 18. Implementation Slices

1. Server history index and batch endpoint behind `history_sync_v1`.
2. Edge link-state table and structural trigger gate.
3. Raw history uploader using id cursors, with server compatibility enabled.
4. Coverage audit and safe backlog migration tooling.
5. Raw trigger removal.
6. Derived dirty-key tracker and derived trigger removal.
7. Irrigation event UUID migration and history sync.
8. Hash-based parity, repair, and reconciliation reporting.

Each slice must update both Pi profiles and the relevant verifier before it is
considered complete.
