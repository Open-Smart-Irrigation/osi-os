# AgroLink scoped multi-user access — design

**Date:** 2026-07-23 (v3, revised for cloud access administration and integration)
**Status:** Approved direction, implementation sequenced by the parity orchestrator
**Context:** Agroscope deployment (rebranded AgroLink): one Pi 5 hub (16 GB RAM, NVMe RAID) serving 20–30 researcher accounts, OSI cloud sync enabled. Current OSI OS edge is built as one farm with a handful of trusted local accounts; this spec adds fully scoped multi-user access.
**ADR:** [2026-07-19-scoped-multiuser-access-model.md](../../adr/2026-07-19-scoped-multiuser-access-model.md)
**Companion spec:** [2026-07-19-agrolink-hub-hardening-design.md](2026-07-19-agrolink-hub-hardening-design.md) (operational hardening, independent)

## 1. Goal and non-goals

Every account on the AgroLink hub sees and acts only within its assigned scope. Scope has two domains: irrigation **zones** (hardware: devices, valves, schedules, sensor history) and journal **plots** (research records). The same model is enforced on the edge hub and, after sync, on osi-server for remote access.

Non-goals: multi-farm tenancy on one gateway (the farm/zone/sync aggregates assume one tenant), a plugin/ACL framework, per-sensor granularity below zone level, changing the authorization behavior of existing deployments.

## 2. Locked decisions

| # | Decision | Consequence |
|---|----------|-------------|
| D1 | Scoping covers both layers: zones for hardware, plots for journal | Two assignment tables; the existing `journal_plots.zone_uuid` column is the bridge between domains |
| D2 | Roles: `admin`, `researcher`, `viewer` | Role decides action class; scope decides which resources |
| D3 | Researchers get direct control within scope (valves, schedules) | Physical-effect paths get uncached authorization checks (§8); a scoping bug actuates someone else's valve |
| D4 | Weather/environment data (S2120, LoRain, `zone_shared_environment`) is readable by all authenticated users; gateway and unassigned hardware are admin-only | Read filter keys on device profile, not only zone assignment |
| D5 | Same scoped model on osi-server, researchers get cloud accounts | Role and assignments remain per-gateway membership (§11), never the cloud's global user role; cloud administration requests changes through pending commands |
| D6 | Researchers provision devices and create/delete zones within scope | Provisioning handlers move from trusted single-operator input to untrusted multi-user input |
| D7 | Whole system behind a per-gateway feature flag, default off | Existing farms keep their current authorization behavior; schema, audit attribution, and sync payloads still evolve on upgrade (§13) |

## 3. Definitions

- **Owner**: the single account a resource is bound to by its shipped column — `irrigation_zones.user_id`, `devices.user_id`, `journal_plots.owner_user_uuid` (migration 0020). Ownership is pre-existing behavior; this spec does not remove it.
- **Principal**: the authenticated account acting in a request, identified by `user_uuid`. The journal API already threads a principal object (`osi-journal/api.js`); this spec extends that seam to all handlers.
- **Grant**: a row in `user_zone_assignments` or `user_plot_assignments` giving a non-owner access. Tombstoned via `deleted_at`, never hard-deleted, so the cloud mirror converges.
- **Scope**: the union of what a principal owns and what it is granted (§4). Resolved server-side per request, never trusted from the client.
- **Scoped mode**: gateway runtime state when `OSI_SCOPED_ACCESS` is enabled. When disabled, all authenticated users behave as today.
- **Desired state**: the cloud's durable representation of a requested edit while its versioned pending command awaits an edge decision. It may drive an optimistic UI overlay, but it is not canonical state.
- **Shared environmental device**: a device whose ChirpStack profile marks it as weather-class (`CHIRPSTACK_PROFILE_S2120`, LoRain). Readable in every scope per D4.

## 4. Ownership model: owner, principal, grants

The shipped schema binds every aggregate to one owner. Scoped mode adds grants on top without migrating ownership, because rewriting owner columns on live hubs would misattribute years of research records and sensor history.

**Access rule: scope = owned ∪ granted.** A principal reaches a resource when it owns the resource (owner column) or holds an active grant (assignment row). Ownership is never revoked by grant changes; a grant revocation removes only the grant. Conflicting rows (owner differs from a grant's target) both grant access — the union is authoritative, no precedence resolution is needed because grants only widen.

Per-aggregate behavior under scoped mode:

| Aggregate | Shipped ownership binding | Scoped-mode access | Multi-assignee behavior |
|---|---|---|---|
| `irrigation_zones` | `user_id` (legacy, single) | Owner plus zone grantees | All grantees may operate; delete restricted by R3 |
| `devices` | `user_id`, zone via `irrigation_zone_id` | Inherits zone scope; weather-class readable by all (D4) | Device follows its zone, never independently granted |
| `irrigation_schedules` | zone-bound, creator user | Zone scope; creator tracked for §8 scheduler authority | Schedule survives grant revocation only per §8 rule |
| `journal_plots` | `owner_user_uuid` (0020) | Owner plus plot grantees | R4 governs zone-link removal |
| `journal_plot_groups`, entries, values, vocabulary | `owner_user_uuid` chain via plot | Follows the plot's scope | Entries keep original author attribution |
| Zone env/recommendations, history, exports | zone-bound queries | Filtered to principal's zone set | Shared env exception per D4 |

Every existing query that filters on an owner column (`listPlots` filters `p.owner_user_uuid=?` *and* constrains the zone join with `z.user_id=?`, `osi-journal/api.js`) must be enumerated and extended to the union rule during implementation. The plan phase produces that enumeration as a checklist; the §14 behavioral tests fail on any missed query.

## 5. Data model

### 5.1 The trigger constraint (hard repo invariant)

The frozen `sync-init-fn` boot node drops and recreates **31 sync triggers on every boot** (verified: 31 distinct `DROP TRIGGER IF EXISTS` statements in the shipped flow, including `trg_sync_users_uuid_ai`). A migration that edits an existing trigger's body is silently reverted on the next Node-RED restart. Two consequences shape this design:

1. **No existing trigger body changes.** Everything this spec needs propagates through new, migration-owned triggers.
2. New triggers live in the migration, the seed, and the `MIGRATION_OWNED_TRIGGERS` allowlist in `scripts/verify-runtime-schema-parity.js` — never in the boot node. Precedent: migration 0005's `trg_improvement_requests_outbox_ai`. Editing a boot-managed trigger body instead requires the full frozen-node merge gate (four verifiers plus production-copy rehearsal) and is treated as a design failure here.

There is no users outbox trigger today; `trg_sync_users_uuid_ai` only assigns `user_uuid`. Role and disable state therefore reach the cloud through a new `USER` aggregate with its own migration-owned trigger (§11), not by modifying anything that exists.

### 5.2 Next free additive schema migration

The source patch's migration filenames are historical only. An integration must enumerate `database/migrations/ordered/` at its target head and allocate this migration and §5.3 as the next two free contiguous versions. At the 2026-07-23 audit they are likely `0033` and `0034`, but the executor must re-enumerate immediately before creating either file.

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'researcher'
  CHECK (role IN ('admin','researcher','viewer'));
ALTER TABLE users ADD COLUMN disabled_at TEXT;
ALTER TABLE users ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE user_zone_assignments (
  assignment_uuid      TEXT PRIMARY KEY,
  user_uuid            TEXT NOT NULL,
  zone_uuid            TEXT NOT NULL,
  assigned_by_user_uuid TEXT,
  gateway_device_eui   TEXT,
  sync_version         INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT,
  deleted_at           TEXT
);
CREATE UNIQUE INDEX uq_user_zone_active
  ON user_zone_assignments(user_uuid, zone_uuid) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_zone_by_zone
  ON user_zone_assignments(zone_uuid) WHERE deleted_at IS NULL;

CREATE TABLE user_plot_assignments (
  assignment_uuid      TEXT PRIMARY KEY,
  user_uuid            TEXT NOT NULL,
  plot_uuid            TEXT NOT NULL,
  assigned_by_user_uuid TEXT,
  gateway_device_eui   TEXT,
  sync_version         INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT,
  deleted_at           TEXT
);
CREATE UNIQUE INDEX uq_user_plot_active
  ON user_plot_assignments(user_uuid, plot_uuid) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_plot_by_plot
  ON user_plot_assignments(plot_uuid) WHERE deleted_at IS NULL;
```

The reverse indexes answer "who holds this zone/plot" (needed by R3 sole-assignee checks and admin screens) without scanning by user. New migration-owned outbox triggers fire on insert and tombstone update for both assignment tables, and on synced `USER` changes.

Commit `101d1f2f` is accepted patch material for the `USER` version contract. It verified durable `users.sync_version`, writer-bumped versions in the same write as each synced mutation, and trigger emission from `NEW.sync_version`. This is required behavior, not a design option to reconsider during the rebase. The parity fixture additionally requires a positive initial version, so new user and grant rows start at 1 and the data migration normalizes older rows before producers can be enabled. Writers that change role, disabled state, username, or another synced user field increment `sync_version` in that same statement. Later grant or user mutations increase it. Trigger bodies observe the new value and never perform a second version bump.

### 5.3 Following free data migration

Idempotent backfill for **in-place upgrades only**: normalize non-positive user versions to 1; then, on a hub that already has users, the operator names the bootstrap admin via a migration input (or, absent input, the lowest-`id` active account is promoted and the runbook tells the operator to verify). Promotion increments `sync_version` in the same write as the role change. This migration does nothing on a fresh image, where the users table is empty; the fresh-hub path is the registration-time rule in §13.

### 5.4 Verification strategy

Standard migration gates apply (`verify-migrations`, `verify-seed-replay`, `verify-runtime-schema-parity`, `verify-db-schema-consistency`, bcm2709 profile parity), with the new triggers registered in `MIGRATION_OWNED_TRIGGERS`. A static ratchet (`scripts/verify-scoped-access.js`) fails if an HTTP handler lacks a scope-resolution call outside an explicit allowlist (login, bootstrap registration, `/api/me`, shared env reads). The ratchet is necessary but not sufficient: it proves a call exists, not that it is correct. The real gate is the behavioral test matrix in §14 plus code review; a handler calling `assertZoneAccess` with the wrong uuid, or after the mutation, passes the ratchet and must fail review.

## 6. Permission matrix

| Capability | Admin | Researcher | Viewer |
|---|---|---|---|
| Manage accounts, roles, grants | ✔ | – | – |
| Gateway settings, health detail, identity, database download | ✔ | – | – |
| Create zone (auto-grant to creator, R1) | ✔ | ✔ | – |
| Delete zone (sole-grantee rule, R3) | ✔ | ✔ | – |
| Claim/register device into an in-scope zone (R2) | ✔ | ✔ | – |
| Claim device without zone assignment | ✔ | – | – |
| Valves, schedules, zone config in scope | ✔ | ✔ | – |
| Journal entries in scope | ✔ | ✔ | – |
| Read owned + granted zones/plots, history, exports | ✔ | ✔ | ✔ |
| Read shared environmental data (D4) | ✔ | ✔ | ✔ |

## 7. Lifecycle rules

- **R1 — zone creation auto-grant.** A researcher-created zone inserts its `user_zone_assignments` row in the same transaction as the zone. Otherwise the creator could not see their own zone.
- **R2 — provisioning terminates in scope.** Researcher claim/register flows require a target zone from their scope in the same request. The claimed-but-unassigned state remains reachable only by admins.
- **R3 — zone delete safety.** A researcher deletes a zone only when they are its sole active grantee (checked via the reverse index). Multi-grantee zones require an admin. Deletion keeps existing `deleted_at` tombstone semantics and sync behavior, and tombstones all grants on that zone in the same transaction (dangling-grant policy).
- **R4 — plots survive zone deletion.** `journal_plots.zone_uuid` is plain TEXT with no foreign key, so the database enforces nothing; the zone-delete transaction explicitly nulls the column on linked plots, bumps their `sync_version`, and emits the corresponding journal outbox events. Plots owned by or granted to other users follow the same path — they lose the zone link, never the plot or its journal entries.
- **R5 — no foreign enumeration.** Claim lists, device pickers, and zone pickers show only unclaimed (admin only) or in-scope resources. Claim of a device already assigned to a foreign zone returns the same 404 as a nonexistent device.
- **R6 — plot creation keeps shipped ownership.** Creating a plot sets `owner_user_uuid` to the creator (current behavior, `osi-journal/api.js`). No grant row is needed for the creator — the union rule (§4) already covers owners. Grants exist to add *other* accounts.

## 8. Enforcement architecture

New shared module `osi-scope-helper` (next to `osi-db-helper` under `usr/share/node-red/`, loaded via the existing `osiLib.require` pattern). Interface:

```js
resolveScope(userUuid)        // → { role, zoneUuids:Set, plotUuids:Set, disabled }
filterZoneUuids(userUuid, uuids)
assertZoneAccess(userUuid, zoneUuid)   // throws {status:404} when outside scope
assertPlotAccess(userUuid, plotUuid)   // throws {status:404} when outside scope
assertRole(userUuid, 'admin')          // throws {status:403} when role insufficient
assertFreshZoneAccess(userUuid, zoneUuid)  // uncached, for physical-effect paths
assertFreshPlotAccess(userUuid, plotUuid)
isAdmin(userUuid)
```

**Cache policy.** Read paths resolve scope from a 30 s per-user cache in Node-RED global context; the epoch bumps on grant writes, role changes, and disables, so routine revocation propagates within seconds. **Physical-effect and privilege paths never use the cache**: valve commands, schedule mutation, zone config writes, device claim/assign, account and grant management, and `/download/database` run `assertFresh*` — direct indexed SELECTs against the assignment and users tables — and read `disabled_at` synchronously. A disabled account loses actuation on the next request, not within 30 s. Status-code rule: out-of-scope resources answer 404 (anti-enumeration, R5), authenticated-but-wrong-role actions answer 403.

**Hook point.** Every protected handler already validates the Bearer token. Handlers extend that step: resolve the principal's `user_uuid`, then apply the cached or fresh check as the path demands. Read endpoints (zone/device lists, history queries, CSV exports, dendro/chameleon reads, zone environment and recommendations) filter through `filterZoneUuids`; shared-env reads (D4) bypass the zone filter but still require an enabled account. Admin-only endpoints check `assertRole`.

**Scheduler authority.** The actuation path is reachable from scheduler nodes that run without a user. Scheduler origin is established inside the flow (an internal marker set by the scheduler node itself), never from request metadata, so a crafted request cannot impersonate it. Schedules are owned by their creator's `user_uuid`; when an account is disabled or loses its zone grant, its schedules in that zone are disabled in the same transaction (the row stays for audit; `enabled` clears). An admin can re-enable or reassign them. Scheduler-originated actuation re-checks that the owning account is enabled and still in scope at execution time — cheap, because schedule firings are rare relative to sensor traffic.

## 9. Audit

`applied_commands.originator` is populated with the acting `user_uuid` on all user-originated actuation and zone-config writes, in scoped and legacy mode alike; scheduler rows keep the existing scheduler marker. Journal writes keep their shipped author attribution. An admin-only audit endpoint lists recent commands with originator, filterable by user and device.

## 10. API surface changes

- `GET /api/me` — returns `{ username, user_uuid, role, zone_uuids, plot_uuids, features }`. Drives GUI rendering.
- **Bootstrap registration (§13).** `POST /auth/register` is currently unauthenticated. In scoped mode it accepts a registration only while zero admin accounts exist; that first registration becomes admin inside one transaction (insert user, set role, verified by a follow-up SELECT). After an admin exists, public registration closes and account creation moves to the admin endpoints. Legacy mode keeps current behavior.
- Account management (admin): list users, create user, reset password (admin-set temporary password; no email flow), set role, disable/enable. Disable sets `disabled_at`, bumps the scope-cache epoch, and disables the account's schedules per §8.
- Grant management (admin): grant/revoke zone or plot. Writes go to the assignment tables, bump `sync_version`, and sync per §11.
- `GET /api/system/features` gains `scoped_access`.

## 11. Sync contract changes (contract-first, paired with osi-server)

The contract is designed and deployed before any edge producer emits. "Schema installed" (Phase A) is deliberately split from "events emitted" (Phase E): the edge image can ship the migrations with producers disabled until the cloud confirms acceptance.

**New aggregates and operations**, added to `docs/contracts/sync-schema/events.schema.json` and the byte-mirrored osi-server copy:

| Aggregate | Ops | Payload keys | Authority |
|---|---|---|---|
| `USER` | `USER_UPSERTED` | `user_uuid`, `username`, `role`, `disabled_at`, `gateway_device_eui`, `sync_version` | Edge → cloud only |
| `USER_ZONE_ASSIGNMENT` | upsert / delete (tombstone) | `assignment_uuid`, `user_uuid`, `zone_uuid`, `assigned_by_user_uuid`, `sync_version`, `deleted_at` | Edge → cloud only |
| `USER_PLOT_ASSIGNMENT` | upsert / delete (tombstone) | same shape with `plot_uuid` | Edge → cloud only |

Writers increment `sync_version` in the same statement as every synced mutation, and migration-owned triggers emit `NEW.sync_version`. The cloud uses the version as the resource precondition and gap-detection signal. Tombstones replay idempotently: re-applying a delete is a no-op on a converged mirror.

Cloud administration is a supported request path. A cloud account, role, enabled-state, or grant edit writes durable desired state and queues a versioned REST pending command with the expected edge version. The edge rejects a stale precondition as a recoverable conflict, otherwise applies the mutation to canonical SQLite state and emits the normal mirror event. Desired state may appear immediately as an overlay, but the cloud keeps the canonical mirror unchanged until that event arrives and exposes pending, applied, conflicted, rejected, or expired status.

**Cloud identity model.** The cloud `User` keeps its global `USER`/`ADMIN`/`SUPER_ADMIN` role untouched. AgroLink role and enabled state are **per-gateway membership**, stored on or beside the existing `LinkedGatewayAccount` row (which already keys cloud user ↔ `gateway_device_eui` ↔ `local_user_uuid`): add `gateway_role` and `gateway_disabled_at`. A researcher who is admin on one hub holds no privilege on any other gateway. Cloud enforcement resolves the membership for the gateway being accessed, keys scope by the synced `local_user_uuid` and the mirrored assignment tables, and applies the same union rule as §4.

**Sequencing.** The osi-server PR (Flyway mirror and desired-state tables, membership columns, event handlers, command issuers, status model, and scoped query enforcement) merges and deploys first. The edge then gains command handlers and advertises compatible capabilities. Only after both directions are accepted does an edge image enable scoped-access event producers. Without that ordering, the cloud can reject unknown aggregates or queue commands an older edge cannot apply. The paired osi-server spec and Phase E plan define the exact command operations before any contract edit.

## 12. GUI changes

The React GUI reads `/api/me` at login and stores the scope profile alongside the token. Zone and plot pickers, dashboards, and history views render only in-scope resources; mutation controls (valve buttons, schedule editors, claim flows) render only where role and scope allow, and disappear for viewers. New admin screens: user list with role/disable controls, grant editor pairing users with zones and plots. When `scoped_access` is off the GUI renders as today. i18n keys go through the existing workflow (#47 covers the backlog).

## 13. Rollout and feature flag

Flag: `OSI_SCOPED_ACCESS` env/UCI, default off, surfaced in `/api/system/features`. With the flag off, request authorization behaves exactly as today; the schema gains columns and tables, audit gains the originator value, and sync payloads grow new aggregates only in Phase E — visible changes, but none that alter who can do what.

The AgroLink hub image sets the flag at provisioning. Fresh-hub bootstrap: the first registration on a scoped hub with zero admins becomes admin (§10); that admin creates all further accounts, because public registration is closed in scoped mode. In-place upgrade of an existing hub: operator runbook (backup, enable flag, restart Node-RED, confirm the §5.3 backfill promoted the intended account), not an automatic transition.

## 14. Testing

- Unit tests for `osi-scope-helper`: union rule (owner + grant), tombstoned grants, cache TTL, epoch invalidation on grant/role/disable writes, flag-off wildcard, fresh-vs-cached assert paths.
- Migration rehearsal: production-shaped DB copy with users, zones, plots, devices; allocate and apply the next two free scoped-access migrations; assert idempotent behavior. Fresh-image rehearsal: zero users, register first account, assert it becomes admin in one transaction.
- Version rehearsal: assert initial emitted user and grant versions are positive, later synced mutations increase them, and each outbox payload carries the row version from the same write.
- **Restart-reversion test:** apply migrations, restart the flow runtime, assert all migration-owned triggers still exist with their migration bodies (guards the §5.1 invariant against regression).
- Behavioral matrix, mandatory per write endpoint: admin / researcher / viewer / disabled × own scope / foreign scope × flag on/off, plus every R1–R6 rule, especially R5 foreign-enumeration denial and §8 scheduler-origin forgery attempts.
- Concurrency smoke: cold-cache `resolveScope` under a dozen concurrent dashboard readers, timed on Pi-class hardware (validates app-level enforcement overhead before Phase C).
- GUI unit tests for scoped rendering and viewer mode (`npm run test:unit`).
- Paired cloud tests per osi-server conventions before producers are enabled.

## 15. Phasing

| Phase | Deliverable | Gate |
|---|---|---|
| A | Next two free scoped-access migrations, `osi-scope-helper`, flag, `/api/me`, bootstrap registration, verifiers incl. `MIGRATION_OWNED_TRIGGERS` | Migration gates green; fresh-image, in-place, and monotonic-version rehearsals pass; restart-reversion test green |
| B | Read-path enforcement (lists, history, exports, shared-env exception) | Behavioral matrix green for read endpoints |
| C | Write-path enforcement, scheduler authority, audit attribution, R1–R6 | Crafted-request tests green; `applied_commands.originator` populated; revocation measured immediate on actuation |
| D | GUI scoping, admin screens, viewer mode | GUI unit tests; build green |
| E | Paired osi-server spec + implementation for mirror and desired state, per-gateway membership, event handlers, pending-command issuers/handlers, status UI, and cloud enforcement; then edge producers enabled | Cloud accepts aggregates; edge applies versioned access commands; pending and conflict states verified; scoped remote login verified |

Phases A–D are edge-only and ship behind the flag with producers disabled. Phase E is cross-repo and sequenced cloud-first per §11.

## 16. Open questions for the plan phase

- Exact payload and command fields for access resources, matched against osi-server canonicalization and pending-command expectations when the paired spec is refreshed (Phase E, not blocking A–D while the emit gate stays off).
- Whether researcher-created zones need an admin-set water-budget ceiling to protect shared pressure infrastructure; deferred until Agroscope confirms trial layouts.
- Grant expiry (time-boxed access for visiting students) — not in v1; the tombstone model supports it later without schema change.

## 17. Revision history

- **v3 (2026-07-23):** made cloud access administration an explicit desired-state and versioned pending-command workflow while preserving edge authority and per-gateway `LinkedGatewayAccount` membership. Replaced fixed migration numbers with target-head enumeration. Incorporated the accepted `101d1f2f` contract: durable `users.sync_version`, same-write writer increments, and trigger emission of `NEW.sync_version`.
- **v2 (2026-07-19):** folded in two external reviews. Changes: ownership/grant union model (§4); trigger invariant and migration-owned-trigger strategy (§5.1); registration-time bootstrap replacing the lowest-id heuristic (§10, §13); uncached physical-effect checks and scheduler authority (§8); contract-first sync with per-gateway cloud membership (§11); reverse indexes, R4 implementation detail, R6; ratchet demoted to necessary-not-sufficient (§5.4, §14); flag-off claim narrowed (§13).
- v1 (2026-07-19): initial approved direction.
