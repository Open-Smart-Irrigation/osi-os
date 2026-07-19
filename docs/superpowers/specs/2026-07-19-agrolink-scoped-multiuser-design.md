# AgroLink scoped multi-user access — design

**Date:** 2026-07-19
**Status:** Approved direction, pending implementation plan
**Context:** Agroscope deployment (rebranded AgroLink): one Pi 5 hub (16 GB RAM, NVMe RAID) serving 20–30 researcher accounts, OSI cloud sync enabled. Current OSI OS edge is built as one farm with a handful of trusted local accounts; this spec adds fully scoped multi-user access.
**Companion spec:** [2026-07-19-agrolink-hub-hardening-design.md](2026-07-19-agrolink-hub-hardening-design.md) (operational hardening, independent)

## 1. Goal and non-goals

Every account on the AgroLink hub sees and acts only within its assigned scope. Scope has two domains: irrigation **zones** (hardware: devices, valves, schedules, sensor history) and journal **plots** (research records). The same model is enforced on the edge hub and, after sync, on osi-server for remote access.

Non-goals: multi-farm tenancy on one gateway (the farm/zone/sync aggregates assume one tenant), a plugin/ACL framework, per-sensor granularity below zone level, changing the single-operator behavior of existing deployments.

## 2. Locked decisions

| # | Decision | Consequence |
|---|----------|-------------|
| D1 | Scoping covers both layers: zones for hardware, plots for journal | Two assignment tables; the existing `journal_plots.zone_uuid` column is the bridge between domains |
| D2 | Roles: `admin`, `researcher`, `viewer` | Role decides action class; scope decides which resources |
| D3 | Researchers get direct control within scope (valves, schedules) | Write-path enforcement must be correct, not cosmetic; a scoping bug actuates someone else's valve |
| D4 | Weather/environment data (S2120, LoRain, `zone_shared_environment`) is readable by all authenticated users; gateway and unassigned hardware are admin-only | Read filter keys on device profile, not only zone assignment |
| D5 | Same scoped model on osi-server, researchers get cloud accounts | Assignment tables become sync aggregates; paired edge/cloud PRs per the cross-repo contract rule |
| D6 | Researchers provision devices and create/delete zones within scope | Provisioning handlers move from trusted single-operator input to untrusted multi-user input |
| D7 | Whole system behind a per-gateway feature flag, default off | Existing farms keep current behavior byte-for-byte; AgroLink hub provisions with the flag on |

## 3. Definitions

- **Scope**: the set of zone_uuids and plot_uuids assigned to a user. Resolved server-side per request, never trusted from the client.
- **Assignment**: a row in `user_zone_assignments` or `user_plot_assignments`. Tombstoned via `deleted_at`, never hard-deleted, so the cloud mirror converges.
- **Scoped mode**: gateway runtime state when `OSI_SCOPED_ACCESS` is enabled. When disabled, all authenticated users behave as today (legacy single-farm mode).
- **Shared environmental device**: a device whose ChirpStack profile marks it as weather-class (`CHIRPSTACK_PROFILE_S2120`, LoRain). Readable in every scope per D4.

## 4. Data model

Two migrations, split by risk class per AGENTS.md.

### 4.1 `0022__scoped_access_schema.sql` (additive)

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'researcher'
  CHECK (role IN ('admin','researcher','viewer'));
ALTER TABLE users ADD COLUMN disabled_at TEXT;

CREATE TABLE user_zone_assignments (
  assignment_uuid      TEXT PRIMARY KEY,
  user_uuid            TEXT NOT NULL,
  zone_uuid            TEXT NOT NULL,
  assigned_by_user_uuid TEXT,
  gateway_device_eui   TEXT,
  sync_version         INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT,
  deleted_at           TEXT
);
CREATE UNIQUE INDEX uq_user_zone_active
  ON user_zone_assignments(user_uuid, zone_uuid) WHERE deleted_at IS NULL;

CREATE TABLE user_plot_assignments (
  assignment_uuid      TEXT PRIMARY KEY,
  user_uuid            TEXT NOT NULL,
  plot_uuid            TEXT NOT NULL,
  assigned_by_user_uuid TEXT,
  gateway_device_eui   TEXT,
  sync_version         INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT,
  deleted_at           TEXT
);
CREATE UNIQUE INDEX uq_user_plot_active
  ON user_plot_assignments(user_uuid, plot_uuid) WHERE deleted_at IS NULL;
```

Outbox triggers on both assignment tables (`AFTER INSERT` / `AFTER UPDATE` for tombstones), producing new aggregates `USER_ZONE_ASSIGNMENT` and `USER_PLOT_ASSIGNMENT` with upsert/delete ops, payload shape and `contract_version` stamp following the existing trigger pattern from migration 0003. The `users` outbox trigger is replaced (drop + create, no table rebuild) to add `role` and `disabled_at` to its payload. No `zone_plot_links` table: `journal_plots.zone_uuid` already links plots to zones (D1).

### 4.2 `0023__scoped_access_backfill.sql` (data)

Idempotent backfill: the lowest-`id` active user becomes `admin`. All other existing users keep the column default `researcher`. On existing single-farm deployments this is inert until the flag is enabled; the operator then has one admin who can reassign roles.

### 4.3 Verifiers

Standard migration gates apply (`verify-migrations`, `verify-seed-replay`, `verify-runtime-schema-parity`, `verify-db-schema-consistency`, profile parity for bcm2709). Add `scripts/verify-scoped-access.js`: a ratchet that fails if an HTTP handler in the maintained profiles lacks a scope-resolution call, exempting an explicit allowlist (login, register, `/api/me`, shared env reads). This mirrors how `check-mqtt-topics.sh` guards the MQTT IN rule.

## 5. Permission matrix

| Capability | Admin | Researcher | Viewer |
|---|---|---|---|
| Manage accounts and assignments | ✔ | – | – |
| Gateway settings, health detail, identity, database download | ✔ | – | – |
| Create zone (auto-assigned to creator, §6 R1) | ✔ | ✔ | – |
| Delete zone (sole-assignee rule, §6 R3) | ✔ | ✔ | – |
| Claim/register device into an in-scope zone (§6 R2) | ✔ | ✔ | – |
| Claim device without zone assignment | ✔ | – | – |
| Valves, schedules, zone config in assigned zones | ✔ | ✔ | – |
| Journal entries in assigned plots | ✔ | ✔ | – |
| Read assigned zones/plots/history/exports | ✔ | ✔ | ✔ |
| Read shared environmental data (D4) | ✔ | ✔ | ✔ |

## 6. Zone and device lifecycle rules

- **R1 — creation auto-assignment.** A researcher-created zone inserts its `user_zone_assignments` row in the same transaction as the zone. Otherwise the creator could not see their own zone.
- **R2 — provisioning terminates in scope.** Researcher claim/register flows require a target zone from their scope in the same request. The claimed-but-unassigned state remains reachable only by admins.
- **R3 — zone delete safety.** A researcher deletes a zone only when they are its sole active assignee. Multi-assignee zones require an admin. Deletion keeps existing `deleted_at` tombstone semantics and sync behavior.
- **R4 — plots survive zone deletion.** Deleting a zone nulls `journal_plots.zone_uuid` on linked plots; plots and journal entries are never cascade-deleted. Research records outlive irrigation hardware.
- **R5 — no foreign enumeration.** Claim lists, device pickers, and zone pickers show only unclaimed (admin only) or in-scope resources. A researcher cannot enumerate devices in other users' zones, including by guessing DevEUIs: claim of a device already assigned to a foreign zone returns the same 404 as a nonexistent device.

## 7. Enforcement architecture

New shared module `osi-scope-helper` (next to `osi-db-helper` under `usr/share/node-red/`, loaded via the existing `osiLib.require` pattern). Interface:

```js
resolveScope(userUuid)        // → { role, zoneUuids:Set, plotUuids:Set, disabled }
filterZoneUuids(userUuid, uuids)
assertZoneAccess(userUuid, zoneUuid)   // throws {status:404} when outside scope
assertPlotAccess(userUuid, plotUuid)   // throws {status:404} when outside scope
assertRole(userUuid, 'admin')          // throws {status:403} when role insufficient
isAdmin(userUuid)
```

Resolution reads the two assignment tables plus `users.role`/`disabled_at`, cached in Node-RED global context for 30 s per user_uuid; assignment writes bump a context epoch to invalidate early. When scoped mode is off, `resolveScope` returns an admin-equivalent wildcard so handlers need one code path. Status-code rule: out-of-scope resources answer 404 (anti-enumeration, R5), authenticated-but-wrong-role actions answer 403.

**Hook point.** Every protected handler already validates the Bearer token and knows the username. Handlers extend that step: resolve `user_uuid`, then scope. Read endpoints (zone/device lists, history queries, CSV exports, dendro/chameleon reads, zone environment and recommendations) filter through `filterZoneUuids`; shared-env reads (D4) bypass the zone filter but still require authentication. Write endpoints (valve open/cancel, schedule CRUD, zone config/location, device assign, journal writes) call `assertZoneAccess`/`assertPlotAccess` on the target before executing, so a crafted request cannot reach a foreign resource even if the GUI hid it. Admin-only endpoints (account management, assignments, gateway settings, unassigned claims, sync/link config, `/download/database`) check `isAdmin`.

**Write-path correctness (D3).** The actuation path — valve commands, ChirpStack downlink enqueue, `applied_commands` — gets the membership check at the REST boundary and again inside the command-build function, because the same function is reachable from scheduler nodes that run without a user. Scheduler-originated actuation carries no user and is exempt; user-originated actuation always carries one.

## 8. Audit

`applied_commands.originator` is populated with the acting `user_uuid` on all user-originated actuation and zone-config writes; scheduler rows keep the existing scheduler marker. Journal writes already carry plot ownership from migration 0020; entry attribution uses the authenticated user. An admin-only audit endpoint lists recent commands with originator, filterable by user and device.

## 9. API surface changes

- `GET /api/me` — returns `{ username, user_uuid, role, zone_uuids, plot_uuids, features }`. Drives GUI rendering; costs one scope resolution per load, cached.
- Account management (admin): list users, create user, reset password, set role, disable/enable. Disable sets `disabled_at`; disabled users fail auth on next token validation (30 s cache bounds the revocation delay).
- Assignment management (admin): assign/revoke zone or plot to a user. Writes go to the assignment tables and sync per §10.
- `GET /api/system/features` gains `scoped_access`.

## 10. Sync contract changes (paired with osi-server)

New outbox aggregates `USER_ZONE_ASSIGNMENT` and `USER_PLOT_ASSIGNMENT` (upsert/delete via tombstone), `role` and `disabled_at` added to the users sync payload. Contract version bump coordinated so the cloud PR accepting the new aggregates merges before any edge image emits them; otherwise the cloud rejects unknown aggregates and the events land in `rejected_at` limbo. On the cloud side: Flyway mirror tables, scope resolution keyed by the same `user_uuid`, enforcement in the controllers/services that serve researcher accounts, and scoped remote dashboards. Details live in the osi-server paired spec; the edge must not depend on cloud behavior for local enforcement (edge-authoritative rule).

## 11. GUI changes

The React GUI reads `/api/me` at login and stores the scope profile alongside the token. Zone and plot pickers, dashboards, and history views render only in-scope resources; mutation controls (valve buttons, schedule editors, claim flows) render only where role and scope allow, and disappear for viewers. New admin screens: user list with role/disable controls, assignment editor pairing users with zones and plots. When `scoped_access` is off the GUI renders exactly as today. i18n keys go through the existing workflow (#47 covers the backlog).

## 12. Rollout and feature flag

Flag: `OSI_SCOPED_ACCESS` env/UCI, default off, surfaced in `/api/system/features`. Existing deployments upgrade with zero behavior change. The AgroLink hub image sets the flag at provisioning; after migration 0023 the first account is admin and creates researcher/viewer accounts. Migration of a live, already-provisioned hub into scoped mode is a documented operator runbook step (backup, enable flag, restart Node-RED, verify roles), not an automatic transition.

## 13. Testing

- Unit tests for `osi-scope-helper`: role resolution, tombstoned assignments, cache TTL and epoch invalidation, flag-off wildcard.
- Migration rehearsal: seed a copy of a production-shaped DB with three users, zones, plots, devices; apply 0022–0023; assert first-user-admin and idempotent re-run.
- Endpoint tests via the ratchet verifier (§4.3) plus handler-level tests for the five lifecycle rules in §6, especially R5 foreign-enumeration denial.
- GUI unit tests for scoped rendering and viewer mode (`npm run test:unit`).
- Paired cloud tests per osi-server conventions before the contract bump ships.

## 14. Phasing

| Phase | Deliverable | Gate |
|---|---|---|
| A | Migrations 0022–0023, `osi-scope-helper`, flag, `/api/me`, verifiers | Migration + parity verifiers green, rehearsal on DB copy |
| B | Read-path enforcement (lists, history, exports, shared-env exception) | Ratchet verifier green; foreign-scope reads return 404 |
| C | Write-path enforcement, audit attribution, provisioning rules R1–R5 | Crafted-request tests; `applied_commands.originator` populated |
| D | GUI scoping, admin screens, viewer mode | GUI unit tests; build green |
| E | Cloud contract bump + osi-server enforcement (paired PRs) | Cloud accepts aggregates; scoped remote login verified |

Phases A–D are edge-only and ship behind the flag. Phase E is cross-repo and follows the paired-PR rule.

## 15. Open questions for the plan phase

- Exact trigger payload columns for the assignment aggregates, matching osi-server's canonicalization expectations (confirm against the contract schemas during Phase A).
- Whether researcher-created zones need an admin-set water-budget ceiling to protect shared pressure infrastructure; deferred until Agroscope confirms trial layouts.
- Password-reset delivery on a possibly offline hub: admin-set temporary password is the assumed mechanism; no email flow planned.

## 16. Suggested ADR

After this spec is approved, record one ADR: "Scoped multi-user access model on the edge" (D1–D3, D7). It is hard to reverse, surprising without context (the edge was single-tenant by design), and the result of a real trade-off against a cloud-only user model.
