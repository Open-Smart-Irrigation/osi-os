# ADR — Scoped multi-user access model on the edge

**Status:** Accepted — 2026-07-19 (v2, revised after two independent external reviews)
**Closes:** —
**Supersedes:** —
**Superseded by:** —
**Spec:** [`docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md`](../superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md)

## Context

OSI OS was designed as a single-farm appliance: one gateway, one farm, a handful of trusted local accounts. The `users` table has no role column, and HTTP handlers authenticate the Bearer token but do not authorize per resource.

The Agroscope deployment (AgroLink) changes the shape: one shared Pi 5 hub serves 20–30 researcher accounts that must each see and operate only their own trials. Researchers get direct control of valves and schedules inside their scope, plus device provisioning and zone creation. Shared environmental data (weather-class devices) stays readable by all; the gateway itself is admin-only. The same scoped model must hold on osi-server, because researchers also get cloud access.

A capacity analysis ruled out the database as a constraint: sensor write load sits far inside SQLite's WAL envelope, and swapping databases would break `osi-migrate` and the single-file backup model. The real database constraint is topological — all access serializes through one facade queue (see the hub-hardening spec) — and the real functional gap is authorization.

Two external reviews of the v1 design corrected four load-bearing facts, verified against the repo: the frozen boot node recreates all 30 sync triggers on every restart, so migrations must never edit existing trigger bodies; no users outbox aggregate exists to extend; the cloud already models gateway identity per-gateway (`LinkedGatewayAccount`), not on the global user; and a fresh image has zero users at migration time, so a deploy-time backfill cannot produce the first admin.

## Decision

Adopt scoped multi-user access as an opt-in edge capability:

1. **Scope has two domains.** Accounts hold grants on irrigation zones (hardware) and journal plots (research records) via `user_zone_assignments` and `user_plot_assignments`. The existing `journal_plots.zone_uuid` column is the bridge; no link table is added.
2. **Access is the union of ownership and grants.** Shipped single-owner columns (`irrigation_zones.user_id`, `journal_plots.owner_user_uuid`, …) keep their meaning; grants widen access without migrating ownership. Three roles (`admin`, `researcher`, `viewer`) decide action class; scope decides which resources.
3. **Enforcement is server-side and split by risk.** Read paths use a short-lived scope cache; physical-effect and privilege paths (valves, schedules, provisioning, account/grant management, database download) use uncached membership checks and read `disabled_at` synchronously, so revocation is immediate where it matters. Out-of-scope resources answer 404 (anti-enumeration), wrong-role actions 403. Scheduler-originated actuation is an internal, unforgeable execution path whose schedules are disabled when the owning account loses scope.
4. **Everything propagates through new migration-owned triggers.** New aggregates (`USER`, `USER_ZONE_ASSIGNMENT`, `USER_PLOT_ASSIGNMENT`) get triggers delivered by migration + seed + the `MIGRATION_OWNED_TRIGGERS` allowlist, never the boot node. No existing trigger body changes; that route would force the frozen-boot-node merge gate and is treated as design failure.
5. **Edge-authoritative, contract-first.** The cloud deploys acceptance for the new aggregates before any edge producer emits ("schema installed" split from "events emitted"). Grants are edge-admin-originated in v1. On the cloud, AgroLink role and enabled state are **per-gateway membership** on the `LinkedGatewayAccount` axis (cloud user ↔ gateway EUI ↔ local user_uuid); the global `User.role` is untouched, so privilege never leaks across gateways.
6. **Feature-flagged, default off** (`OSI_SCOPED_ACCESS`). Existing deployments keep their current authorization behavior. Bootstrap is a registration-time rule: the first registration on a scoped hub with zero admins becomes admin in one transaction, after which public registration closes and account creation is admin-only. Deploy-time backfill covers only the in-place upgrade path.

## Consequences

- Authorization becomes a first-class edge concern: ~118 HTTP endpoints gain a scope-resolution step. A static ratchet guards presence; correctness is enforced by a behavioral test matrix (per endpoint: admin/researcher/viewer/disabled × own/foreign scope × flag state) and code review, because a ratchet can be satisfied by a wrong or misplaced call.
- Provisioning handlers (`REGISTER_DEVICE`, claim flows) move from trusted single-operator input to untrusted multi-user input and get scope validation.
- The sync contract grows three aggregates; contract changes for access control follow the paired-PR rule permanently, cloud-first.
- Audit improves for everyone: `applied_commands.originator` is populated on user-originated actuation regardless of flag state.
- Every existing owner-filtered query (the journal API's `owner_user_uuid` filters are the dense cluster) must be enumerated and extended to the union rule; a missed query either denies legitimate grantees or leaks across scopes.
- Scoped mode is a one-way door for a hub once accounts and grants accumulate; migrating a live hub in or out is an operator runbook step, not an automatic transition.

## Alternatives considered

- **Cloud-only user model (hub stays single-account).** Rejected: AgroLink requires on-LAN operation with offline tolerance, and edge-authoritative actuation means cloud-issued permissions would be unenforceable during outages.
- **DB-level enforcement (views, per-connection context).** Rejected: SQLite has no session user, and all access funnels through one facade queue with no per-request context to key on.
- **External authorization proxy in front of Node-RED.** Rejected: duplicates knowledge of the whole API surface in a second service and breaks the single-embedded-service model.
- **Multi-farm tenancy on one gateway.** Rejected: farm/zone/sync aggregates assume one tenant; that is a rewrite, and AgroLink needs scoped users, not scoped farms.
- **Editing existing sync triggers in migrations (v1 approach).** Rejected by repo invariant: the frozen boot node recreates trigger bodies every restart, silently reverting migration edits.

## Flip conditions

Revisit if any of these become true: a second hub-class deployment needs disjoint tenants on one gateway (multi-farm); role count or permission complexity outgrows the matrix (e.g. per-action grants); cloud-side grant administration becomes a requirement (adds the command path); or the cold-cache enforcement overhead benchmark (scoped spec §14) shows request-latency impact on the Pi 5 beyond budget.
