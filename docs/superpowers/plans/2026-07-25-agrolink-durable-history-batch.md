# AgroLink durable history batch plan

**Date:** 2026-07-25
**Status:** Approved
**Repositories:** `osi-os` and `osi-server`

## Rebaseline

The history-v1 foundation is present but not durable:

- the edge worker sends only `device_data` and always labels it `shadow`;
- the server validates only `device_data`, writes no canonical mirror row, and
  rejects every non-shadow phase;
- the edge cursor keeps shadow progress separate from durable progress;
- segment manifests are stored on the server but are not compared;
- the legacy event and bootstrap mirrors remain the only durable path.

Task 9 promotes the batch path without removing or narrowing that legacy
delivery.

## Covered families

| Edge table | Cursor | Stable history key | Server target |
|---|---|---|---|
| `device_data` | numeric `id` | gateway plus local row ID | `sensor_data` |
| `chameleon_readings` | numeric `id` | gateway plus local row ID | `chameleon_readings` |
| `dendrometer_readings` | numeric `id` | gateway plus local row ID | `dendro_readings` |
| `dendrometer_daily` | natural key | device EUI plus local date | `dendro_daily` |
| `zone_daily_environment` | natural key | zone UUID plus local date | `zone_daily_environment` |
| `zone_daily_recommendations` | natural key | zone UUID plus local date | `zone_daily_recommendations` |
| `irrigation_events` | numeric `id` | stable event UUID | `irrigation_events` |
| `valve_actuation_expectations` | natural key | expectation UUID | dedicated cloud mirror |

The `edge_history_row_index` primary key is the row idempotency key. A repeat
with the same payload hash is a duplicate; a repeat with a new hash is an
edge-authoritative correction.

These history families do not have a deletion contract. Their manifest
tombstone count is therefore exactly zero. A nonzero tombstone count is a
contract error, not permission to delete mirrored history.

## Rollout rules

1. Land server durable acceptance before changing the edge producer.
2. A server shadow response advertises durable-v1 support explicitly.
3. Each table completes at least one shadow comparison before its edge cursor
   can send a durable phase.
4. Durable ACKs advance only the contiguous committed prefix. Retryable rows
   and transport failures leave the durable cursor unchanged.
5. Raw inserts use numeric cursors. Corrections and derived rows use dirty
   keys and natural-key scans.
6. The worker rotates tables so high-volume telemetry cannot starve smaller
   histories.
7. Segment parity compares canonical count, syncable count, quarantine count,
   tombstone count, ordered keys, and ordered payload hashes.
8. The server never applies a manifest as a deletion instruction and adds no
   retention policy for canonical mirrored history.
9. Legacy telemetry outbox triggers, bootstrap arrays, and server event
   handlers remain enabled.

## Slice A: durable server acceptance

1. Add failing mapper and ingest tests for all eight tables.
2. Add failing tests for shadow capability negotiation, durable apply,
   duplicate, correction, out-of-order input, retryable interruption, and
   replay after interruption.
3. Add the cloud valve-actuation mirror migration.
4. Reuse the existing canonical legacy mirror writers for the seven existing
   server targets, and add the dedicated actuation writer.
5. Return the accepted phase and durable capability in batch responses.
6. Keep one transaction per bounded batch and return only a committed
   contiguous ACK boundary.

## Slice B: rotating edge worker

1. Add failing helper and flow-contract tests for the eight-table registry,
   queries, stable keys, table rotation, phase negotiation, dirty-key
   corrections, durable ACKs, retry backoff, and restart from persisted
   cursors.
2. Add an additive migration for actuation dirty-key tracking.
3. Extend the shared history helper and golden fixtures in both maintained
   profiles.
4. Replace the hard-coded flow builder and marker through an exact one-shot
   flow migration script. Mirror the resulting flow and helper bytes to the
   maintained bcm2709 profile.
5. Preserve the frozen boot DDL and all legacy outbox/bootstrap behavior.

## Slice C: measured parity and repair evidence

1. Compute bounded edge segments for all eight families.
2. Compare server row-index keys and payload hashes with each submitted
   segment. Return explicit matched or mismatched fields.
3. Exercise bounded backfill, retry, duplicate, correction, out-of-order,
   interruption, cursor restart, and zero-tombstone cases.
4. Prove that a manifest mismatch requests repair without deleting either
   canonical edge rows or server mirrors.
5. Run the complete edge sync/schema/profile gates and complete server test
   suite.

## Slice D: documentation and acceptance

1. Create `docs/sync/history-sync-v1.md` as the current operational contract.
2. Update the parity matrix and execution report with measured counts, hashes,
   tests, and exact pushed SHAs.
3. Mark farm history mirror `parity` while leaving legacy-path removal and
   incremental bootstrap explicitly deferred.

## Acceptance criteria

- Every covered table has a deterministic mapper and stable idempotency key.
- Shadow and durable paths use the same canonical hash.
- Bounded fixtures produce equal edge/server counts, keys, hashes, quarantine
  counts, and zero tombstones.
- Duplicate, correction, out-of-order, interruption, retry, and persisted
  cursor restart tests pass.
- Durable cursor advancement never outruns the server's committed prefix.
- The legacy durable history path remains active and tested.
- No server retention deletes canonical mirrored history.
- Both integration branches are pushed and exact remote heads are verified
  before Task 10 starts.
