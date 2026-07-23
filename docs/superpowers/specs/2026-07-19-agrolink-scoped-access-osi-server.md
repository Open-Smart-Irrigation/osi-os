# AgroLink scoped access — paired osi-server spec

**Date:** 2026-07-19
**Status:** Paired spec required by edge spec §11 before any contract edit
**Edge spec:** [2026-07-19-agrolink-scoped-multiuser-design.md](2026-07-19-agrolink-scoped-multiuser-design.md) (v5, §11)
**Repo:** `../osi-server` (Spring Boot, PostgreSQL, Flyway). Edge repo remains the contract authority per Phase F.

## 1. Purpose

The cloud learns three new edge aggregates (`USER`, `USER_ZONE_ASSIGNMENT`, `USER_PLOT_ASSIGNMENT`) and enforces the same scoped model for remote access, keyed by per-gateway membership. The global `User.role` (`USER`/`ADMIN`/`SUPER_ADMIN`) is untouched; AgroLink role and enabled state live per gateway on the `LinkedGatewayAccount` axis. Edge is authoritative: grants are edge-admin-originated; the cloud mirrors and enforces, never originates (v1).

## 2. Contract changes (edge-owned, Phase F regime)

Added to `docs/contracts/sync-schema/events.schema.json` op enum and to `resources.schema.json` definitions, byte-mirrored into the server test resources per the Phase F vendoring rule:

- `USER_UPSERTED`. Payload: `user_uuid`, `username`, `role` (`admin|researcher|viewer`), `disabled_at` (nullable), `sync_version`, `gateway_device_eui`, `occurred_at`.
- `USER_ZONE_ASSIGNMENT_UPSERTED` / `USER_ZONE_ASSIGNMENT_DELETED`. Payload: `assignment_uuid`, `user_uuid`, `zone_uuid`, `assigned_by_user_uuid`, `gateway_device_eui`, `sync_version`, plus `deleted_at` on the delete op.
- `USER_PLOT_ASSIGNMENT_UPSERTED` / `USER_PLOT_ASSIGNMENT_DELETED`. Same shape with `plot_uuid`.

New aggregate types are additive; a cloud that has not deployed this spec rejects them into `rejected_at` without affecting other events (existing behavior), which is why deployment order is cloud-first.

## 3. Schema (Flyway)

`V<next>__agrolink_gateway_membership.sql`:

```sql
ALTER TABLE linked_gateway_accounts
  ADD COLUMN gateway_role VARCHAR(16) NOT NULL DEFAULT 'researcher'
    CHECK (gateway_role IN ('admin','researcher','viewer')),
  ADD COLUMN gateway_disabled_at TIMESTAMPTZ;

CREATE TABLE user_zone_assignments_mirror (
  assignment_uuid TEXT PRIMARY KEY,
  user_uuid TEXT NOT NULL,
  zone_uuid TEXT NOT NULL,
  assigned_by_user_uuid TEXT,
  gateway_device_eui TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  last_event_uuid TEXT
);
CREATE INDEX uza_mirror_user ON user_zone_assignments_mirror(user_uuid) WHERE deleted_at IS NULL;
CREATE INDEX uza_mirror_zone ON user_zone_assignments_mirror(zone_uuid) WHERE deleted_at IS NULL;

CREATE TABLE user_plot_assignments_mirror (
  -- identical shape, plot_uuid instead of zone_uuid
);
CREATE INDEX upa_mirror_user ON user_plot_assignments_mirror(user_uuid) WHERE deleted_at IS NULL;
CREATE INDEX upa_mirror_plot ON user_plot_assignments_mirror(plot_uuid) WHERE deleted_at IS NULL;
```

Mirror tables keep the edge's tombstone model; rows are never hard-deleted. `last_event_uuid` feeds the existing inbox dedupe. Users themselves are not mirrored; `local_user_uuid` on `LinkedGatewayAccount` is the join key (§4).

## 4. Event handling

`EdgeSyncService`'s op switch gains three cases (verified location: the `switch (event.op())` dispatch):

- `USER_UPSERTED`: resolve the `LinkedGatewayAccount` row for `(gateway_device_eui, user_uuid)`; upsert `gateway_role` and `gateway_disabled_at`. Unknown pair → `RETRYABLE_ERROR` with reason `unknown_local_user`, not a silent skip: the account row may arrive via the auth-sync path later, and USER events precede grant events (edge §5.2 three-arm trigger), so retry converges.
- `*_UPSERTED` (both assignment aggregates): upsert mirror row keyed by `assignment_uuid`, applying only when `sync_version` is newer than stored (idempotent replay).
- `*_DELETED`: set `deleted_at` on the mirror row; replaying a delete on a converged row is a no-op (`DUPLICATE`).

All three follow the existing per-event transaction and result-shape rules (`SyncEventTxExecutor`, `SyncEventResult`); unknown/malformed payloads classify `REJECTED` per the shipped classifier.

## 5. Enforcement

Remote (cloud) researcher access resolves membership, then scope:

1. Membership: `(cloud user, gateway EUI)` → `LinkedGatewayAccount` with `local_user_uuid`, `gateway_role`, `gateway_disabled_at`. No row, or disabled → 403. The global `User.role` continues to govern only cloud-native administration.
2. Scope: `local_user_uuid` → owned zone set (existing zone/device ownership mirror) ∪ mirror-table grants; plots likewise through the journal mirror when it lands. Union rule identical to edge §4.
3. Read endpoints serving researcher accounts (zone/device/history dashboards for a gateway) filter through that scope. Command-issuing paths (`VALVE_COMMAND`, schedule/config upserts) check the target zone against it before enqueueing a pending command; the edge re-checks on application regardless (edge-authoritative rule).
4. Out-of-scope resources answer 404; wrong-role answers 403, same anti-enumeration rule as the edge.

## 6. Compatibility and rollout

Deployment order (Phase F compatibility rule): this cloud change deploys first, accepting but not yet enforcing for gateways that emit nothing; the edge then enables `scoped_access_emit` on the AgroLink hub only. Old edges without scoped access are unaffected: no USER events arrive, membership rows stay default (`gateway_role='researcher'`, null disable), and enforcement activates per-gateway only when that gateway's accounts exist with roles: an edge in legacy mode has a single linked operator whose membership is managed on the cloud side as today. Rollback: edge producers off (`scoped_access_emit=0`); the cloud tables and columns are inert.

## 7. Tests (per repo conventions, PostgreSQL integration where noted)

- Event-handler tests for all three aggregates: happy path, replay idempotency, unknown-user retry, version-stale rejection, tombstone replay no-op.
- `FlywayMigrationIT`-style catalog test: columns, CHECK, mirror tables, indexes.
- Enforcement tests: scoped researcher reads own zones (200) / foreign (404); viewer read-only (command enqueue 403); disabled membership 403; admin (gateway_role) full access; global `SUPER_ADMIN` unaffected.
- Vendored-contract validation per Phase F: the new ops validate against the byte-identical vendored `events.schema.json` after the edge contract PR lands.

## 8. Explicit non-goals

- Cloud-originated grant or account management (v1: edge-admin only; a command path is the documented extension).
- Any change to global `User.role` semantics or the existing cloud admin UI.
- Multi-farm tenancy on the cloud (mirrors stay per-gateway as today).
