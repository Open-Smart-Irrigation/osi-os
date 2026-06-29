# Edge-to-Cloud Sync Architecture Redesign

Date: 2026-06-28
Status: Proposed
Decision: Canonical history sync with a link-gated structural outbox

This spec supersedes the earlier draft that treated the whole data plane as a
simple telemetry pipeline. The final design combines:

- Approach 1 as the target architecture: history is synced from canonical
  tables, not from `sync_outbox`.
- Approach 2's raw-table cursor mechanics: raw inserts are tailed by monotonic
  local `id`, while post-insert corrections are tracked through dirty keys.
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

Raw history tables are insert-heavy but not immutable. Existing calibration and
refresh flows can update already inserted `device_data` and
`chameleon_readings` rows after the raw `id` cursor has passed them. The history
sync model therefore needs two mechanisms for raw tables: an id cursor for new
inserts and dirty keys for post-insert corrections.

These facts drive the design: raw inserts must use local row id, raw
corrections and derived rows need dirty-key tracking, and server idempotency
cannot rely only on existing target-table constraints.

## 4. Architecture

```
EDGE (/data/db/farming.db is canonical)

  Structural/config tables
    -> link-gated sync_outbox
    -> POST /api/v1/sync/edge/events

  Raw history inserts
    -> sync_history_cursors by table and local id
    -> POST /api/v1/sync/edge/history/batches

  Raw history corrections and derived/upsert history
    -> initial scan plus sync_history_dirty_keys
    -> POST /api/v1/sync/edge/history/batches

  Daily parity
    -> sync_history_segments hashVersion + counts + payload hash
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
| Raw history | `device_data`, `chameleon_readings`, `dendrometer_readings` | Id-cursor uploader for inserts; dirty-key tracker for corrections; no outbox payload triggers | Idempotent history ingest by `history_key` |
| Derived history | `dendrometer_daily`, `zone_daily_environment`, `zone_daily_recommendations` | Full scan plus dirty-key tracker | Edge-wins upsert by natural key |
| Parity and repair | Segment manifests and targeted rows | Daily canonical count, syncable count, quarantine count, and hash compare | Request/accept repairs, quarantine extras |

## 5. Link State Rules

There are two different offline cases and the system must treat them
differently.

### 5.1 Never Linked / Explicitly Unlinked

- No `sync_outbox` rows are created.
- No pending-command polling runs.
- No history jobs run.
- No raw-correction or derived-history dirty keys are created; peer-specific
  dirty keys are removed when unlink clears the account identity.
- Canonical history continues accumulating locally.
- First link runs structural bootstrap and full history backfill.

### 5.2 Linked But Network Offline

- Structural outbox rows may accumulate because a peer exists.
- Raw history inserts are not duplicated; they remain only in canonical tables.
- Raw correction and derived dirty keys may accumulate, but one row key only has
  one dirty-key row per peer/table.
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

This guard is acceptable on low-volume structural triggers. Raw-history insert
triggers are removed entirely and therefore do not pay a hot-path guard cost.
Raw-history update triggers only enqueue bounded dirty keys when linked.

Upgrade invariant: an already-linked gateway is identified by
`users.auth_mode='server'` and a non-empty `users.server_url`. Runtime startup,
image migrations, and `deploy.sh` must backfill `sync_link_state('cloud')` from
that existing `users` row and the canonical gateway EUI before link-gated
triggers are trusted. Do not read `linked_users` for this migration; current
field databases do not contain that table.

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

### 6.2 Raw History Inserts and Corrections

Remove raw inserts from `sync_outbox`:

| Table | Insert cursor | History key |
|---|---|---|
| `device_data` | local `id` | `DEVICE_DATA|<gateway_eui>|<edge_id>` |
| `chameleon_readings` | local `id` | `CHAMELEON_READING|<gateway_eui>|<edge_id>` |
| `dendrometer_readings` | local `id` | `DENDRO_READING|<gateway_eui>|<edge_id>` |

Do not use `recorded_at` as the tail cursor. Late or out-of-order uplinks can
arrive with old timestamps but new local ids; an id cursor catches them.

Raw rows are not assumed immutable. Post-insert updates to sync-relevant
columns must enqueue a history dirty key for the row. Known examples include
Chameleon calibration and local calibration backfills that update
`device_data.swt_1`, `device_data.swt_2`, `device_data.swt_3`, or
`chameleon_readings.calibration_status` after initial ingest. If future
dendrometer or weather-quality flows correct old raw rows, they use the same
dirty-key mechanism.

The raw correction trigger only records the changed row key; it does not copy
the full payload into an outbox table. The uploader re-reads the current
canonical row before sending.

### 6.3 Derived / Upsert History

Target state: remove these from `sync_outbox` after the dirty-key tracker is
proven:

| Table | Dirty row key | Notes |
|---|---|---|
| `dendrometer_daily` | `DENDRO_DAILY|<deveui>|<date>` | Updates to old days must enqueue the same key again |
| `zone_daily_environment` | `ZONE_ENVIRONMENT|<zone_uuid>|<date>` | No local `id`; resolve `zone_id` through `irrigation_zones` |
| `zone_daily_recommendations` | `ZONE_RECOMMENDATION|<zone_uuid>|<date>` | Updates to old days must enqueue the same key again |

`zone_daily_environment` stores integer `zone_id`, but sync identity must use
stable `zone_uuid`. Dirty-key builders and backfill queries must join
`irrigation_zones` by `zone_id` and must not filter out soft-deleted zones.
Soft-deleted zones still provide the UUID needed to keep historical daily rows
addressable. If a daily row cannot resolve a `zone_uuid`, the row is not
silently skipped; it is quarantined and surfaced as a local schema/data error.

Normal zone deletion is a structural soft delete through the `ZONE` aggregate
and tombstone event. Historical daily rows remain authoritative edge history.
Hard deletes or cascading deletes of historical rows are repair-only operations
and must be explicit; they are not inferred from a zone tombstone.

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

Backfill existing rows once using the hub EUI from `sync_link_state` or the
same UCI/identity helper used by sync linking:

```text
event_uuid = 'irrig-' || <gateway_device_eui> || '-' || printf('%012d', id)
```

`origin_gateway_eui` is not added to `irrigation_events` solely for this
backfill. If the gateway EUI cannot be resolved, the migration stops and asks
for operator repair instead of generating unstable IDs.

Until `event_uuid` is present and verified, keep irrigation events on the
existing event path during rollout.

## 7. Edge Schema

### 7.1 History Cursors

```sql
CREATE TABLE IF NOT EXISTS sync_history_cursors (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'backfill',
  snapshot_high_id INTEGER,
  last_acked_id INTEGER,
  last_acked_key TEXT,
  backfill_started_at TEXT,
  backfill_completed_at TEXT,
  last_batch_id TEXT,
  last_batch_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name)
);
```

Raw tables use `last_acked_id`. Derived tables use `last_acked_key` only for
scan progress during full backfill; ongoing changes are driven by dirty keys.
Backfill and tail are states of one cursor row, not separate primary-key rows.
This avoids duplicate cursor authorities for the same peer/table.

Backfill captures `snapshot_high_id = max(id)` when the job starts. Once
`last_acked_id >= snapshot_high_id`, the cursor changes to `state='tail'`.
Rows inserted after the snapshot high id are naturally handled by the same
cursor.

### 7.2 History Dirty Keys

```sql
CREATE TABLE IF NOT EXISTS sync_history_dirty_keys (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  change_kind TEXT NOT NULL DEFAULT 'correction',
  source_row_id INTEGER,
  changed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name, row_key)
);
```

Triggers on raw update and derived/upsert tables use
`INSERT ... ON CONFLICT DO UPDATE` so a row corrected or recomputed ten times
still occupies one dirty-key row. Dirty-key triggers are link-gated and must
not create peer rows when the hub has never linked.

Recommended `change_kind` values:

| Value | Meaning |
|---|---|
| `correction` | Raw row changed after insertion |
| `upsert` | Derived row inserted or recomputed |
| `tombstone` | Explicit history deletion where the table supports deletion semantics |

### 7.3 Segment Cache

```sql
CREATE TABLE IF NOT EXISTS sync_history_segments (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  hash_version INTEGER NOT NULL,
  canonical_row_count INTEGER NOT NULL,
  syncable_row_count INTEGER NOT NULL,
  syncable_payload_hash TEXT NOT NULL,
  quarantined_count INTEGER NOT NULL DEFAULT 0,
  covered_max_id INTEGER,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (peer_node, table_name, segment_key, hash_version)
);
```

Segment keys are usually `device_eui|YYYY-MM-DD`, `zone_uuid|YYYY-MM-DD`, or a
monthly bucket for older low-change ranges.

`canonical_row_count` includes every edge row in the segment.
`syncable_row_count` and `syncable_payload_hash` exclude rows already in local
quarantine for that peer/table. `quarantined_count` keeps parity reports honest:
a segment can be "syncable hash matches" while still carrying data-quality debt
that must remain visible to operators.

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
whole stream. Retryable failures must not advance cursors. Quarantined rows are
excluded from syncable segment hashes and included in canonical/quarantine
counts so they do not create permanent false parity failures.

### 7.5 Required Indexes

Existing raw-table primary keys support `WHERE id > ? ORDER BY id LIMIT ?`.
Keep the existing `(deveui, recorded_at)` and `(zone_id, date)` indexes for
range reads, parity buckets, diagnostics, and GUI history.

Add missing derived indexes only if query plans show table scans during parity
or dirty-key lookup.

## 8. History Keys and Payload Hashes

Every history row sent to the server has:

- `hashVersion`: integer hash contract version.
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

Using edge local id for raw insert rows avoids timestamp collisions and does
not require destructive deduplication of existing field data. Server queries
can still use natural timestamps for analysis; the history key is for sync
identity.

### 8.1 Hash Version 1 Canonical Encoding

Hash version 1 uses a typed column vector, not generic JavaScript or Java JSON
serialization. The hash input is UTF-8 JSON with exactly these fields and with
object keys emitted in the order shown:

```json
{
  "hashVersion": 1,
  "tableName": "device_data",
  "historyKey": "DEVICE_DATA|0016C001F11715E2|123",
  "columns": [
    ["id", "INTEGER", "123"],
    ["recorded_at", "TIMESTAMP", "2026-06-28T10:00:00.000Z"],
    ["swt_1", "REAL", "3ff0000000000000"],
    ["payload_json", "JSON", "{\"a\":1,\"b\":null}"]
  ]
}
```

Encoding rules:

1. Each table has an explicit ordered column list. The ordered list is part of
   the contract and must be mirrored in edge and server code.
2. `NULL` values encode as JSON `null`, with the SQL type still present in the
   column tuple.
3. `TEXT` encodes as the exact UTF-8 string after SQLite retrieval. No locale or
   display formatting is applied.
4. `INTEGER` encodes as a base-10 string with no leading `+`.
5. `REAL` encodes as IEEE-754 binary64 big-endian lowercase hex. `-0` is
   normalized to positive zero. `NaN`, `Infinity`, and `-Infinity` are invalid
   sync payload values and must be quarantined, not hashed.
6. `BOOLEAN` encodes as `true` or `false`.
7. `TIMESTAMP` encodes as UTC ISO-8601 with millisecond precision and a `Z`
   suffix.
8. `JSON` columns are parsed and re-emitted with object keys sorted
   lexicographically and no insignificant whitespace. Invalid JSON in a JSON
   contract column is quarantined. Plain text payload columns must use `TEXT`,
   not `JSON`.

The SHA-256 digest is computed over the UTF-8 bytes of that canonical JSON.
Any change to encoding rules, table names, ordered column lists, or type labels
requires a new `hashVersion`.

### 8.2 Golden Fixtures

Create canonical fixture JSON at:

```text
docs/sync/history-hash-v1-fixtures.json
```

The same fixture file must be vendored or mirrored into `osi-server`. The
fixture set includes raw rows, derived rows, nulls, booleans, integers, REAL
edge cases, timestamps, JSON, and expected hashes. Both repositories expose a
verifier that prints the fixture file SHA-256 as `fixtureSetSha256`; when the
repos are adjacent, `osi-os` verification should also compare the two fixture
checksums.

No repair or hash-parity feature is enabled until both repos pass the same
golden vectors.

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

### 9.3 Raw Insert Backfill and Tail

For each raw table:

```sql
SELECT *
  FROM <table>
 WHERE id > ?
 ORDER BY id ASC
 LIMIT ?;
```

Cursor advancement rules:

- Cursor advances only to the `ackedThroughId` explicitly returned by the
  server for a committed batch.
- The server only returns an `ackedThroughId` for the contiguous prefix it has
  applied, deduped, updated, or quarantined in the same transaction.
- Cursor does not advance past retryable server or network failures.
- Backfill captures `snapshot_high_id = max(id)` when a job starts. Reaching
  that id marks backfill complete; later rows are tail sync on the same cursor.
- The worker processes one bounded batch per tick and interleaves tables so
  `device_data` cannot starve smaller streams.

The edge does not infer cursor advancement from per-row statuses. The server is
the only authority for the committed ACK boundary.

### 9.4 Raw Correction Sync

Raw correction dirty keys are processed before or alongside insert tail batches.
For each pending dirty key:

1. Re-read the canonical row by local `id`.
2. Recompute `payloadHash` with the current row state.
3. Send the row through the same batch endpoint with `phase='correction'`.
4. On committed ACK, delete or mark the dirty key delivered.
5. If the row no longer exists, quarantine locally unless the table has an
   explicit deletion contract.

The server treats same `historyKey` with a different `payloadHash` as an
edge-sourced update, not as a duplicate insert.

### 9.5 Derived Backfill and Dirty Sync

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

### 9.6 Bootstrap

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
  hash_version INTEGER NOT NULL,
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
  "hashVersion": 1,
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

Response envelope:

```json
{
  "batchId": "uuid",
  "tableName": "device_data",
  "hashVersion": 1,
  "ackedThroughId": 600,
  "ackedThroughKey": null,
  "recommendedBatchSize": 500,
  "minIntervalMs": 30000,
  "results": [
    {
      "historyKey": "DEVICE_DATA|0016C001F11715E2|123",
      "status": "APPLIED"
    }
  ]
}
```

Processing:

1. Authenticate with the sync token.
2. Validate `hashVersion` and the table-specific payload contract.
3. Validate gateway ownership of every device or zone referenced by the row.
4. Look up `(gateway_eui, table_name, history_key)` in
   `edge_history_row_index`.
5. If no index row exists, apply the row to the mirror table and create the
   index row.
6. If the same hash already exists, return `DUPLICATE`.
7. If the key exists with a different hash, update the edge-sourced mirror row
   from the edge payload, record `conflict_state='EDGE_OVERWROTE_SERVER'`, and
   return `UPDATED`.
8. If gateway ownership, account authorization, or table-level authorization
   fails, return `REJECTED_PERMANENT` and stop the ACK prefix before that row.
9. If ownership is valid but the row payload is permanently invalid, return
   `QUARANTINED` and include the row in the committed ACK prefix.
10. If a server dependency is temporarily unavailable, return
   `RETRYABLE_ERROR` and stop the ACK prefix before that row.

The server must commit table writes, index writes, quarantine records, and the
explicit `ackedThroughId` or `ackedThroughKey` boundary in one transaction
before ACKing cursor advancement.

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

### 10.4 Server Spec Mirror

The `osi-server` implementation must include either a mirror of this protocol
spec or a short pointer document that names this spec as the source of truth and
records the server-side tables, endpoints, capability flag, and verifier
commands. The server pointer is part of Phase 0, because the protocol contract
spans two repositories.

### 10.5 Backward Compatibility

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
      "hashVersion": 1,
      "canonicalRowCount": 288,
      "syncableRowCount": 288,
      "quarantinedCount": 0,
      "syncablePayloadHash": "64-hex"
    }
  ]
}
```

Segment generation should be incremental where possible. The daily job checks
recent windows first, then rotates through older windows over time.

The server compares syncable counts and hashes for normal parity. Canonical and
quarantine counts are reported separately so permanent local rejections remain
visible without causing endless repair attempts.

### 11.2 Comparison Outcomes

| Case | Detection | Repair |
|---|---|---|
| Edge has row/server missing | Edge syncable segment count or hash differs | Server asks edge to upload missing range or whole segment |
| Server has extra edge-sourced row | Server index has key absent from edge segment after confirmation | Quarantine first, then prune edge-sourced mirror row after second confirmation or operator approval |
| Same key, different payload | Same history key, different hash | Edge payload overwrites server mirror and conflict is recorded |
| Local row permanently invalid | Canonical count exceeds syncable count and quarantine count is non-zero | Operator-visible data-quality issue; no endless retry loop |
| Structural tombstone missing | Config parity or event replay detects server active row | Edge re-emits structural tombstone event |

The server never writes repaired history back to the edge. Edge remains
authoritative.

### 11.3 Repair Endpoint

Use the same batch ingest contract for repair:

`POST /api/v1/sync/edge/history/batches` with `phase='repair'`.

The difference is operational context, not payload format.

## 12. Migration Plan

### Phase 0: Server Compatibility and Contract

1. Add `edge_history_row_index`.
2. Add history batch and manifest endpoints.
3. Add capability advertisement: `history_sync_v1`.
4. Add hash-version 1 golden fixtures and verifiers in both repos.
5. Add the `osi-server` mirror/pointer spec.
6. Keep old events and bootstrap behavior unchanged.
7. Add server tests for duplicate, update, rejection, quarantine, ownership,
   ACK-boundary, and conflict paths.

### Phase 1: Edge Schema, No Behavior Change

1. Add link state, history cursor, dirty-key, segment, and quarantine tables.
2. Add `irrigation_events.event_uuid` and backfill legacy rows.
3. Add raw-correction and derived dirty-key triggers behind the link gate, but
   do not drop old outbox triggers yet.
4. Update verifiers to assert the new tables exist in both Pi profiles.
5. Verify never-linked hubs still create no `sync_outbox` rows and no dirty-key
   rows.

### Phase 2: Shadow History Upload and Parity

1. Run raw insert uploader and raw-correction dirty-key uploader in shadow while
   old telemetry triggers still feed `sync_outbox`.
2. Server dedupes old event path and new history path using the history index
   plus existing watermarks.
3. Run parity in diagnostic-only mode using hash-version 1 manifests.
4. Do not mark any residual outbox rows delivered yet.

### Phase 3: Coverage Audit and Field Recovery

Before removing or pruning history outbox rows, audit each table:

1. Confirm canonical table coverage by row count and timestamp/id range.
2. Compare residual history outbox rows to canonical rows.
3. If outbox contains older rows missing from canonical tables, recover them on
   a DB copy first.
4. Take a timestamped on-Pi backup of `/data/db/`, `/srv/node-red/`, and
   relevant sync files before any canonical import.
5. Require explicit operator approval before importing recovered rows into the
   canonical database.
6. Keep structural outbox rows untouched.

This phase exists because past field failures left `sync_outbox` with older
history rows than the canonical history tables.

### Phase 4: Remove Raw-History Outbox Triggers

After server capability, hash fixtures, correction dirty keys, coverage, and
parity are proven:

1. Drop `device_data`, `chameleon_readings`, and `dendrometer_readings` outbox
   triggers.
2. Keep the raw insert uploader and raw correction dirty-key uploader as the
   sole raw-history paths.
3. Enable automatic repair for edge-present/server-missing and hash divergence
   on raw tables.
4. Mark only audited and superseded raw-history outbox rows delivered.

### Phase 5: Move Derived and Irrigation Rows

1. Enable dirty-key triggers for derived history if they are not already active
   from Phase 1.
2. Run in parallel with existing derived outbox triggers.
3. Prove parity for derived tables, including old-day recomputes.
4. Drop derived-history outbox triggers.
5. Move irrigation events only after `event_uuid` is populated and verified.

### Phase 6: Narrow Bootstrap and Mature Repair

1. New firmware stops sending history arrays in bootstrap.
2. Server still tolerates old arrays from old firmware.
3. Automatic repair is enabled for all history tables where ownership and hash
   contracts are proven.
4. Server-extra pruning remains two-confirmation or operator-approved until the
   final pruning policy is selected.

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

- Raw ingest hot path must not execute full-payload sync triggers.
- Raw upload queries must be `WHERE id > ? ORDER BY id LIMIT ?`.
- 1M-row raw-table cursor queries must stay under 500 ms on Pi 5 and under 2 s
  on Pi 4 using the primary-key id cursor.
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
- A never-linked hub creates no history dirty-key rows.
- Linking later uploads all local canonical history, not just bootstrap
  windows.
- Unlinking stops outbox delivery, pending-command polling, and history jobs.
- Linked network-offline operation accumulates only bounded structural outbox
  rows and bounded raw-correction/derived dirty keys.

### Raw History

- Raw history insert outbox triggers are absent in the final target.
- Backfill ships every canonical raw row exactly once logically, with duplicate
  retries returning `DUPLICATE`.
- Late uplinks with old `recorded_at` and new local `id` are uploaded.
- Post-insert raw corrections after the cursor passed are delivered through
  dirty keys.
- Chameleon calibration backfill updates are mirrored to the server.
- Killing Node-RED mid-backfill resumes from the last server-returned
  `ackedThroughId`.

### Derived History

- Old-day recomputes of daily rows are delivered through dirty keys.
- `zone_daily_environment` sync does not assume an `id` column.
- `zone_daily_environment` resolves `zone_uuid` through `irrigation_zones`
  without filtering soft-deleted zones.
- Derived parity detects missing rows, extra rows, and hash divergence.

### Server Robustness

- Server ingest is idempotent by `(gateway_eui, table_name, history_key)`.
- Same-key/different-hash rows update the edge-sourced mirror and record a
  conflict.
- Ownership failures reject rows without advancing past the failed row.
- Permanent row-level rejections can be quarantined without blocking later rows.
- Server responses include explicit `ackedThroughId` or `ackedThroughKey`.
- Old firmware event/bootstrap sync continues to work during rollout.

### Migration

- Existing large history outbox backlogs are not blindly discarded.
- If outbox rows contain history missing from canonical tables, recovery is done
  from a DB copy first.
- Canonical import after recovery requires on-Pi backup and explicit operator
  approval.
- Structural outbox rows are preserved throughout migration.

### Verification

- `node scripts/verify-sync-flow.js` checks link-gated structural triggers,
  removed raw-history insert triggers, new history tables, raw correction dirty
  keys, hash fixture checksums, and bootstrap narrowing.
- `node scripts/verify-profile-parity.js` passes for bcm2712 and bcm2709.
- Server tests cover history batches, parity manifests, repair, explicit ACK
  boundaries, quarantine, and backward compatibility.

## 16. Test Strategy

### Edge Unit and SQLite Tests

- Link gate suppresses all `sync_outbox` writes while unlinked.
- Link gate suppresses raw-correction and derived dirty-key writes while
  unlinked.
- Raw cursor query catches late old-timestamp rows by id.
- Raw update after cursor passage enqueues a correction dirty key.
- Chameleon calibration backfill creates a correction dirty key for each
  sync-relevant changed row.
- Cursor advances only to explicit server ACK boundaries.
- Backfill-to-tail handoff uses one cursor row and does not skip rows inserted
  after `snapshot_high_id`.
- Dirty-key trigger coalesces repeated derived updates.
- `zone_daily_environment` derived sync works without an id column and resolves
  soft-deleted zone UUIDs.
- `irrigation_events.event_uuid` backfill is deterministic and unique.
- Quarantine lets later rows continue and excludes bad rows from syncable
  segment hashes.

### Hash and Contract Tests

- Edge and server pass the same hash-version 1 golden fixture set.
- Verifiers print and compare `fixtureSetSha256` when both repositories are
  present.
- REAL values hash by IEEE-754 binary64 hex, including normalized zero.
- NaN and infinity are rejected or quarantined before hashing.
- Hash-version mismatches are rejected before payload application.

### Server Tests

- Batch replay with same rows returns duplicates and creates no extra mirror
  rows.
- Same history key and different hash updates the edge-sourced mirror.
- Chameleon rows dedupe through `edge_history_row_index` even though the target
  table has no unique natural constraint.
- Ownership denial returns permanent rejection.
- Permanent payload rejection can return `QUARANTINED` and still ACK the
  committed prefix.
- Retryable errors stop the ACK prefix before the failed row.
- Old `/edge/events` telemetry still works for old firmware.
- Old bootstrap telemetry arrays are accepted or ignored according to advertised
  capabilities.

### End-to-End Tests

- Fresh unlinked Pi: one hour of sensor data, zero outbox rows, zero history
  dirty-key rows.
- Offline for 30 days, then link: full local canonical history appears on
  server.
- Network loss mid-backfill: resume without gaps.
- Raw row corrected after initial upload: server mirror updates by same
  `historyKey`.
- Derived daily row recomputed for an old date: server receives updated row.
- Server row deleted manually: parity requests repair and edge reuploads.
- Server row modified manually: hash divergence is detected and edge overwrites.
- Server extra edge-sourced row: quarantine first, prune only after confirmation
  or approval.
- Quarantined local row does not create an endless segment hash mismatch.

### Performance Tests

- 1M `device_data` rows: raw batch query meets the Pi 5 and Pi 4 target
  latency using the primary-key id cursor.
- Backfill under active ingest does not cause excessive WAL growth.
- Daily parity manifest is proportional to active segments, not total history.
- Pi 4 and Pi 5 payload files stay byte-for-byte aligned.

## 17. Decisions Before First Implementation Slice

These are resolved for the initial implementation unless a later design review
explicitly changes them:

1. Hash-version 1 uses the typed column-vector encoding in this spec.
2. Full-history backfill means all local canonical history. Any future retention
   cap is a product decision because it weakens the parity promise.
3. Raw-history correction dirty keys are required before raw outbox triggers are
   removed.
4. Derived-history dirty keys are required before derived outbox triggers are
   removed.
5. `zone_daily_environment` sync identity is `zone_uuid|date`; integer
   `zone_id` is only a local join key.

Open decisions that can wait until their implementation slice:

1. Server-extra pruning policy: automatic after two confirmations or
   operator-approved.
2. Whether same-account relink can be proven by `/auth/local-sync` response so
   cursors can be retained confidently.
3. Exact server doc location for the Phase 0 mirror/pointer spec.

## 18. Implementation Slices

1. Hash-version 1 contract fixtures and server history index/batch endpoint
   behind `history_sync_v1`.
2. Edge link-state table, structural trigger gate, and never-linked verifier
   coverage.
3. Raw insert uploader plus raw correction dirty-key tracker in shadow mode.
4. Hash manifests and diagnostic parity for raw tables.
5. Coverage audit and safe backlog migration tooling.
6. Raw trigger removal after correction sync and parity are proven.
7. Derived dirty-key tracker, derived parity, and derived trigger removal.
8. Irrigation event UUID migration and history sync.
9. Bootstrap narrowing, automatic repair, and reconciliation reporting.

Each edge slice must update both Pi profiles and the relevant verifier before
it is considered complete. Server slices must update the `osi-server` verifier
and the Phase 0 protocol pointer.
