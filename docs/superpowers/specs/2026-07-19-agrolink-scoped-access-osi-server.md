# AgroLink scoped access on OSI Server

**Date:** 2026-07-23
**Status:** Approved by the parity-orchestrator decisions; refreshed against
OSI Server `1c953c7`
**Edge authority:** `docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md`

## Purpose

OSI Server must mirror each gateway's local accounts and grants, apply the
same per-gateway authorization boundaries as the edge, and let an authorized
gateway administrator request access changes. A cloud request is desired
state. It becomes canonical only after a versioned pending command is applied
by the edge and the resulting mirror event converges.

The cloud user's global `User.role` does not grant an AgroLink gateway role.
Gateway role and enabled state come from the mirrored local user identified by
`LinkedGatewayAccount.localUserUuid`.

## Verified starting point

- `LinkedGatewayAccount` uniquely binds a cloud user, gateway EUI, and local
  user UUID. It already stores edge capability flags.
- Journal and zone cloud mutations use `DesiredStateService` and durable
  `DeviceCommand` polling. Configuration commands can coalesce only before
  lease.
- Five journal mirror appliers use the governed event dispatcher, resource
  watermarks, equal-version payload conflict rejection, and desired-state
  convergence.
- Scoped event schemas are accepted but staged. No scoped server handler or
  access command exists.
- The edge exposes local account and grant writes, but its admin API has no
  grant-list endpoint. Cloud grant lists therefore come from mirrored grant
  resources, not from proxying that API.

## Chosen architecture

Use normalized per-gateway mirror tables and keep `LinkedGatewayAccount` as
the login-to-local-membership link.

Alternatives rejected:

- Storing only role columns on `LinkedGatewayAccount` loses unlinked local
  accounts and cannot support cloud administration before each account links.
- Storing all scoped resources as JSON on the link row makes version
  watermarks, grant lookups, and independent tombstones unsafe.
- Deriving gateway privilege from global cloud roles leaks authority between
  installations.

### Mirror model

`gateway_user_mirrors` is keyed by `(gateway_eui, local_user_uuid)` and stores
username, gateway role, disabled timestamp, sync version, canonical JSON, and
mirror time.

`user_zone_assignment_mirrors` and `user_plot_assignment_mirrors` are keyed by
`(gateway_eui, assignment_uuid)`. Each stores the target local user, resource
UUID, assigner, version, tombstone, canonical JSON, and mirror time. Partial
indexes serve active grants by user and resource.

`LinkedGatewayAccount.gatewayRole` and `gatewayDisabledAt` are denormalized
from the matching user mirror for fast session summaries. They are not a
second authority: every authorization decision resolves the current mirror
inside the request transaction.

### Event application

The five staged operations are handled by focused appliers:

- `USER_UPSERTED`
- `USER_ZONE_ASSIGNMENT_UPSERTED`
- `USER_ZONE_ASSIGNMENT_DELETED`
- `USER_PLOT_ASSIGNMENT_UPSERTED`
- `USER_PLOT_ASSIGNMENT_DELETED`

The existing transaction executor owns replay, stale-version, equal-version
payload conflict, dead-letter, and desired-state behavior. An applier validates
payload shape, gateway identity, and aggregate identity, then upserts one
mirror. A user event also updates a matching `LinkedGatewayAccount`.

An assignment may arrive before its user. That is a retryable parent miss,
using the existing `parent_missing` result. A tombstone for an unknown
assignment creates a tombstoned mirror so replay and out-of-order delivery
remain deterministic.

### Gateway scope

`GatewayScopeService.resolve(cloudUser, gatewayEui)`:

1. loads the cloud user's `LinkedGatewayAccount`;
2. loads its current local user mirror;
3. rejects missing or disabled membership with 403;
4. returns role plus owned and granted zone/plot UUIDs.

Owned zones are mirrored `IrrigationZone.user.userUuid` rows for the selected
gateway. Owned plots come from `journal_plots_mirror.owner_user_uuid`. Active
assignment mirrors widen each set. Admin role is a wildcard for that gateway.
Viewer role permits reads only. Resource misses and foreign resources both
return 404.

Every gateway-scoped controller uses this service. Super-admin status may
select installations operationally, but never substitutes a gateway-local
role for farm reads or effects.

### Cloud access administration

The server exposes gateway-scoped account and grant APIs. Responses contain a
canonical mirror, the latest desired overlay, and operation status. Mutation
requests require gateway-local admin role and a base version.

Six pending command types are additive:

- `UPSERT_SCOPED_USER`
- `RESET_SCOPED_USER_PASSWORD`
- `UPSERT_USER_ZONE_ASSIGNMENT`
- `DELETE_USER_ZONE_ASSIGNMENT`
- `UPSERT_USER_PLOT_ASSIGNMENT`
- `DELETE_USER_PLOT_ASSIGNMENT`

User creation allocates a canonical local user UUID in the cloud request.
Password creation/reset sends only a BCrypt hash. The plaintext temporary
password is never stored in desired state, a command row, an operation row, a
response, or a log.

User and grant commands use the current mirror version as
`base_sync_version`. Their desired representation excludes command-only
fields. ACK plus a newer matching mirror moves the operation to `APPLIED`.
A base-version rejection becomes `CONFLICTED`.

Password reset has no mirrorable credential field. It is an ACK-only
credential operation: an `APPLIED` edge ACK marks it applied; conflict,
rejection, expiry, and retry behavior otherwise use the normal desired-state
state machine. Password commands never coalesce.

The edge applies each command in one SQLite transaction, checks the exact base
version, protects the last enabled admin, increments the row version in the
same write, invalidates the scope cache, and records the command ledger. A
replay returns the original terminal ACK.

### Capabilities and rollout

Two capability axes are required:

- `scoped_access_sync_v1`: server accepts mirror events and edge producers may
  emit them.
- `scoped_access_commands_v1`: edge accepts access commands and cloud may
  issue them.

Schema acceptance lands first. Server event handlers and edge command handlers
then land with both runtime enablement flags still false. Producer and issuer
flags change only after the opposite side's acceptance is deployed.

This autonomous run cannot deploy production or flip a live gateway. It must
leave both activation flags false and record the exact operator boundary.

## API and UI

Gateway summaries expose local UUID, gateway role, disabled state, and scoped
capabilities. The cloud UI adds a gateway-scoped administration page listing
mirrored users and active grants. It overlays pending desired changes and
shows conflict or rejection details. A cloud user who is admin on one gateway
and viewer on another sees different controls after switching installations.

Disabled membership is checked on every scoped request. It causes immediate
403 denial for reads, privilege changes, and physical effects. The normal
frontend auth token remains valid for other linked installations.

## Failure handling

- Unknown operations remain terminal `unknown_op`.
- Missing parent user is retryable.
- Stale version is terminal at ingest and recoverable as desired-state
  conflict for a cloud request.
- Equal version with different canonical payload is terminal and never
  overwrites a mirror.
- Edge command validation failures are stable permanent rejections.
- Offline edges leave operations pending; leased commands are not rewritten.
- Revocation never reports success before edge ACK and mirror convergence.

## Verification

Required local evidence:

- Flyway migration integration test.
- Event applier unit and replay tests, including equal-version conflict.
- Gateway scope tests for owned, granted, foreign, viewer, disabled, admin,
  and two-gateway role separation.
- Desired account/grant command tests for create, update, revoke, disable,
  re-enable, last-admin rejection, concurrent conflict, and offline recovery.
- Edge command lifecycle tests for apply, replay, stale base, malformed
  payload, and last-admin protection.
- Paired contract mirror, operation parity, backend, frontend, edge sync, and
  scope suites.

No production host, live gateway, or external identity service participates in
verification.
