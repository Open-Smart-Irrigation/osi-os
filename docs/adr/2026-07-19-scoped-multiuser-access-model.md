# ADR — Scoped multi-user access model on the edge

**Status:** Accepted — 2026-07-19
**Closes:** —
**Supersedes:** —
**Superseded by:** —
**Spec:** [`docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md`](../superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md)

## Context

OSI OS was designed as a single-farm appliance: one gateway, one farm, a handful of trusted local accounts. The `users` table has no role column, and HTTP handlers authenticate the Bearer token but do not authorize per resource.

The Agroscope deployment (AgroLink) changes the shape: one shared Pi 5 hub serves 20–30 researcher accounts that must each see and operate only their own trials. Researchers get direct control of valves and schedules inside their scope, plus device provisioning and zone creation. Shared environmental data (weather-class devices) stays readable by all; the gateway itself is admin-only. The same scoped model must hold on osi-server, because researchers also get cloud access.

A capacity analysis ruled out the database as a constraint: at this load (sub-1 write/s, a dozen concurrent readers) SQLite in WAL mode on NVMe is far inside its envelope, and swapping it would break `osi-migrate` and the single-file backup model. The real gap is authorization.

## Decision

Adopt scoped multi-user access as an opt-in edge capability:

1. **Scope has two domains.** Accounts are assigned to irrigation zones (hardware) and journal plots (research records) via `user_zone_assignments` and `user_plot_assignments`. The existing `journal_plots.zone_uuid` column is the bridge; no link table is added.
2. **Three roles** (`admin`, `researcher`, `viewer`) decide action class; assignments decide which resources. Enforcement is server-side per request: a shared `osi-scope-helper` resolves the user's scope, read paths filter through it, write paths assert target membership before executing, and out-of-scope resources answer 404 (anti-enumeration) while wrong-role actions answer 403.
3. **Edge-authoritative enforcement.** The cloud mirrors the assignment tables as new sync aggregates and enforces the same model for remote access, but the edge never depends on cloud behavior for local decisions. The cloud PR accepting the new aggregates merges before any edge image emits them.
4. **Feature-flagged, default off** (`OSI_SCOPED_ACCESS`). Existing single-farm deployments keep current behavior byte-for-byte; the AgroLink hub provisions with the flag on, and the first account becomes admin by backfill.

## Consequences

- Authorization becomes a first-class edge concern: ~118 HTTP endpoints gain a scope-resolution step, guarded by a new ratchet verifier (`verify-scoped-access.js`) so new handlers cannot ship without it.
- Provisioning handlers (`REGISTER_DEVICE`, claim flows) move from trusted single-operator input to untrusted multi-user input and get scope validation.
- The sync contract grows two aggregates plus `role`/`disabled_at` on the users payload; contract bumps for access control now follow the paired-PR rule permanently.
- Audit improves for everyone: `applied_commands.originator` is populated on user-originated actuation regardless of flag state.
- Scoped mode is a one-way door for a hub once accounts and assignments accumulate; migrating a live hub in or out is an operator runbook step, not an automatic transition.

## Alternatives considered

- **Cloud-only user model (hub stays single-account).** Researchers would authenticate only against osi-server; the edge keeps one operator account. Rejected: AgroLink requires on-LAN operation with offline tolerance, and edge-authoritative actuation means cloud-issued permissions would be unenforceable during outages.
- **DB-level enforcement (views, per-connection context).** Rejected: SQLite has no session user, and the ~85 connection-per-call sites in flows.json would bypass it.
- **External authorization proxy in front of Node-RED.** Rejected: duplicates knowledge of the whole API surface in a second service and breaks the single-embedded-service model.
- **Multi-farm tenancy on one gateway.** Rejected: farm/zone/sync aggregates assume one tenant; that is a rewrite, and AgroLink needs scoped users, not scoped farms.

## Flip conditions

Revisit if any of these become true: a second hub-class deployment needs disjoint tenants on one gateway (multi-farm), role count or permission complexity outgrows the matrix (e.g. per-action grants), or enforcement overhead shows up in request latency on the Pi 5 (the 30 s scope cache is the first lever, not more roles).
