# AgroLink scoped multi-user access — design

**Date:** 2026-07-19 (v2, revised after two independent external reviews)
**Status:** Approved direction, pending implementation plan
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
| D5 | Same scoped model on osi-server, researchers get cloud accounts | Role and assignments sync as per-gateway membership (§11), never into the cloud's global user role |
| D6 | Researchers provision devices and create/delete zones within scope | Provisioning handlers move from trusted single-operator input to untrusted multi-user input |
| D7 | Whole system behind a per-gateway feature flag, default off | Existing farms keep their current authorization behavior; schema, audit attribution, and sync payloads still evolve on upgrade (§13) |

## 3. Definitions

- **Owner**: the single account a resource is bound to by its shipped column — `irrigation_zones.user_id`, `devices.user_id`, `journal_plots.owner_user_uuid` (migration 0020). Ownership is pre-existing behavior; this spec does not remove it.
- **Principal**: the authenticated account acting in a request, identified by `user_uuid`. The journal API already threads a principal object (`osi-journal/api.js`); this spec extends that seam to all handlers.
- **Grant**: a row in `user_zone_assignments` or `user_plot_assignments` giving a non-owner access. Tombstoned via `deleted_at`, never hard-deleted, so the cloud mirror converges.
- **Scope**: the union of what a principal owns and what it is granted (§4). Resolved server-side per request, never trusted from the client.
- **Scoped mode**: gateway runtime state when `OSI_SCOPED_ACCESS` is enabled. When disabled, all authenticated users behave as today.
- **Shared environmental device**: a device whose ChirpStack profile marks it as weather-class (`CHIRPSTACK_PROFILE_S2120`, LoRain). Readable in every scope per D4.

## 4. Ownership model: owner, principal, grants

The shipped schema binds every aggregate to one owner. Scoped mode adds grants on top without migrating ownership, because rewriting owner columns on live hubs would misattribute years of research records and sensor history.

**Access rule: scope = owned ∪ granted.** A principal reaches a resource when it owns the resource (owner column) or holds an active grant (assignment row). Ownership is never revoked by grant changes; a grant revocation removes only the grant. Conflicting rows (owner differs from a grant's target) both grant access — the union is authoritative, no precedence resolution is needed because grants only widen.

Per-aggregate behavior under scoped mode:

| Aggregate | Shipped ownership binding | Scoped-mode access | Multi-assignee behavior |
|---|---|---|---|
| `irrigation_zones` | `user_id` (legacy, single) | Owner plus zone grantees | All grantees may operate; delete restricted by R3 |
| `devices` | `user_id`, zone via `irrigation_zone_id` | Inherits zone scope; weather-class readable by all (D4) | Device follows its zone, never independently granted |
| `irrigation_schedules` | zone-bound, one per zone (`UNIQUE(irrigation_zone_id)`) | Zone scope; no per-creator concept | Shared by all zone grantees; §8 governs mutation and execution |
| `journal_plots` | `owner_user_uuid` (0020) | Owner plus plot grantees | R4 governs zone-link removal |
| `journal_plot_groups`, entries, values, vocabulary | `owner_user_uuid` chain via plot | Follows the plot's scope | Entries keep original author attribution |
| Zone env/recommendations, history, exports | zone-bound queries | Filtered to principal's zone set | Shared env exception per D4 |

Every existing query that filters on an owner column (`listPlots` filters `p.owner_user_uuid=?` *and* constrains the zone join with `z.user_id=?`, `osi-journal/api.js`) must be enumerated and extended to the union rule during implementation. The plan phase produces that enumeration as a checklist; the §14 behavioral tests fail on any missed query.

## 5. Data model

### 5.1 The trigger constraint (hard repo invariant)

The frozen `sync-init-fn` boot node drops and recreates **30 sync triggers on every boot** (verified: 30 distinct `DROP TRIGGER IF EXISTS` targets inside `sync-init-fn`, including `trg_sync_users_uuid_ai`; a 31st drop in `dendro-compute-fn` is unrelated). A migration that edits an existing trigger's body is silently reverted on the next Node-RED restart. Two consequences shape this design:

1. **No existing trigger body changes.** Everything this spec needs propagates through new, migration-owned triggers.
2. New triggers live in the migration, the seed, and the `MIGRATION_OWNED_TRIGGERS` allowlist in `scripts/verify-runtime-schema-parity.js` — never in the boot node. Precedent: migration 0005's `trg_improvement_requests_outbox_ai`. Editing a boot-managed trigger body instead requires the full frozen-node merge gate (four verifiers plus production-copy rehearsal) and is treated as a design failure here.

There is no users outbox trigger today; `trg_sync_users_uuid_ai` only assigns `user_uuid`. Role and disable state therefore reach the cloud through a new `USER` aggregate with its own migration-owned trigger (§11), not by modifying anything that exists.

### 5.2 `0022__scoped_access_schema.sql` (additive)

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'researcher'
  CHECK (role IN ('admin','researcher','viewer'));
ALTER TABLE users ADD COLUMN disabled_at TEXT;
ALTER TABLE users ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;

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
CREATE INDEX idx_user_zone_by_zone
  ON user_zone_assignments(zone_uuid) WHERE deleted_at IS NULL;

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
CREATE INDEX idx_user_plot_by_plot
  ON user_plot_assignments(plot_uuid) WHERE deleted_at IS NULL;
```

The reverse indexes answer "who holds this zone/plot" (needed by R3 sole-assignee checks and admin screens) without scanning by user. New migration-owned outbox triggers fire on insert and on tombstone update for both assignment tables. No trigger body bumps `sync_version` itself; the writer bumps it in the same statement that changes the row, and the trigger only reads `NEW.sync_version` (§11). A grant `INSERT` sets `sync_version = 1`; a tombstone `UPDATE` bumps `sync_version` alongside `deleted_at` in that same statement, matching migration 0003's writer-bumped pattern.

The `USER` aggregate needs three trigger arms, because of a verified SQLite behavior: a sibling trigger's UPDATE during the same INSERT is not visible to another AFTER INSERT trigger (reproduced: the shipped `trg_sync_users_uuid_ai` fills `user_uuid` on insert, yet a second AFTER INSERT trigger reads NULL through both `NEW.user_uuid` and a fresh SELECT). A bare INSERT trigger would therefore emit `USER_UPSERTED` with a null uuid. Instead:

```sql
-- Arm 1: uuid assigned by the shipped trigger (the common account-creation path)
CREATE TRIGGER trg_dp_users_outbox_uuid_au AFTER UPDATE OF user_uuid ON users
FOR EACH ROW WHEN NEW.user_uuid IS NOT NULL BEGIN … emit USER_UPSERTED … END;
-- Arm 2: caller supplied the uuid directly at insert
CREATE TRIGGER trg_dp_users_outbox_ai AFTER INSERT ON users
FOR EACH ROW WHEN NEW.user_uuid IS NOT NULL AND NEW.user_uuid != '' BEGIN … emit USER_UPSERTED … END;
-- Arm 3: role/disable mutations (uuid-guarded like the others, so a role write
-- on a pre-backfill row can never emit a null-keyed event)
CREATE TRIGGER trg_dp_users_outbox_role_au AFTER UPDATE OF role, disabled_at ON users
FOR EACH ROW WHEN NEW.user_uuid IS NOT NULL AND NEW.user_uuid != '' BEGIN … emit USER_UPSERTED … END;
```

Every emitted payload carries a non-null `user_uuid`, so a user event always precedes any grant event that references it; the cloud never resolves membership for an unknown `local_user_uuid`. §14 adds a test asserting the emitted payload's uuid is non-null on the trigger-assigned path.

Arm 1's trigger fires because of DML (the nested `UPDATE`) issued from inside a *different* trigger's body — a non-cyclic cascade, not self-recursion. This is unaffected by SQLite's default `recursive_triggers=OFF`, which suppresses only a trigger re-firing itself; confirmed empirically against both `node:sqlite` and the on-device `sqlite3` binding during implementation-plan review. No `PRAGMA recursive_triggers` change belongs anywhere in this codebase for this mechanism to work.

### 5.3 `0023__scoped_access_backfill.sql` (data)

Two idempotent jobs. First, `user_uuid` backfill: any legacy user row with a null uuid gets one assigned (the shipped `trg_sync_users_uuid_ai` covers inserts, so this closes the pre-trigger era), giving the §8 identifier bridge a total function to work with. Second, admin promotion for **in-place upgrades only**: on a hub that already has users, the operator names the bootstrap admin via a migration input (or, absent input, the lowest-`id` active account is promoted and the runbook tells the operator to verify). On a fresh image the users table is empty and both jobs are no-ops; the fresh-hub path is the registration-time rule in §13.

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

**Identifier bridge.** `resolveScope` takes the text `user_uuid` and internally joins `users.user_uuid → users.id`, because zone and device ownership is keyed by the integer `users.id` while plots, grants, and the journal use the text uuid. Migration 0023 backfills `user_uuid` for any legacy rows where it is null (the shipped `trg_sync_users_uuid_ai` already assigns it on insert, so new accounts always have one). The resolver treats a null uuid as a hard error, never as an empty scope.

**Hook point.** Every protected handler already validates the Bearer token. Handlers extend that step: resolve the principal's `user_uuid`, then apply the cached or fresh check as the path demands. Read endpoints (zone/device lists, history queries, CSV exports, dendro/chameleon reads, zone environment and recommendations) filter through `filterZoneUuids`; shared-env reads (D4) bypass the zone filter but still require an enabled account. Admin-only endpoints check `assertRole`.

**Scheduler authority.** The actuation path is reachable from scheduler nodes that run without a user. Scheduler origin is established inside the flow (an internal marker set by the scheduler node itself), never from request metadata, so a crafted request cannot impersonate it. Schedules are zone resources, one per zone, shared by all grantees; there is no per-creator ownership and no creator column is added. Schedule mutation requires fresh zone scope (`assertFreshZoneAccess`). At execution time the scheduler checks that the zone still has at least one enabled account in scope, evaluated on the union of owners and grantees, not on any single row: when a disable, a grant revocation, or a de-provision empties that set, the schedule's `enabled` flag clears and the zone is flagged for admin review. An admin can re-enable it. **Stated policy:** a schedule is collective zone infrastructure — it keeps actuating as long as any one enabled account holds the zone in scope, authorized by whoever currently holds scope, not by its original creator. Because no creator column exists, per-creator tracking is impossible by design; instead, any scope change on a zone (grant revoked, account disabled) flags that zone's schedule for admin re-confirmation in the GUI while it keeps running, so unattended actuation always has a visible review prompt. For user-originated actuation, the membership re-assertion repeats inside the same queue write step that enqueues the downlink, closing the check-to-enqueue race on the serialized writer; the residual window is one already-queued command and is documented.

## 9. Audit

`applied_commands.originator` is populated with the acting `user_uuid` on all user-originated actuation and zone-config writes, in scoped and legacy mode alike; scheduler rows keep the existing scheduler marker. Journal writes keep their shipped author attribution. An admin-only audit endpoint lists recent commands with originator, filterable by user and device.

## 10. API surface changes

- `GET /api/me` — returns `{ username, user_uuid, role, zone_uuids, plot_uuids, features }`. Drives GUI rendering.
- **Bootstrap registration (§13).** `POST /auth/register` is currently unauthenticated. In scoped mode it accepts a registration only while no admin row exists in any state (enabled or disabled), evaluated as a single conditional write on the serialized queue: `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM users WHERE role='admin')`. Two concurrent first registrations cannot both succeed; the loser gets 409. Counting disabled rows keeps bootstrap closed after a sole admin is disabled — the recovery path for that case is the CLI break-glass below, not self-registration. After an admin exists, public registration closes and account creation moves to the admin endpoints. Legacy mode keeps current behavior.
- Account management (admin): list users, create user, reset password (admin-set temporary password; no email flow), set role, disable/enable. Disable sets `disabled_at` and bumps the scope-cache epoch. The last-enabled-admin guard is a single conditional write on the serialized queue, not a check-then-act — e.g. `UPDATE users SET disabled_at=… WHERE user_uuid=? AND disabled_at IS NULL AND (role != 'admin' OR (SELECT COUNT(*) FROM users WHERE role='admin' AND disabled_at IS NULL) > 1)`, zero rows affected → 409. The `role != 'admin'` branch is load-bearing, not decorative: without it the admin-count subquery is evaluated for every target regardless of that target's own role, so disabling a researcher or viewer is wrongly blocked whenever exactly one admin happens to be enabled — the common state on a freshly bootstrapped hub (§13). Two admins concurrently disabling each other cannot both succeed. The same conditional shape covers de-roling and account deletion/tombstone. A hub with no enabled admin is recovered by an operator on the hub CLI (`sqlite3` role reset, documented in the runbook), never by reopening registration.
- Grant management (admin): grant/revoke zone or plot. Writes go to the assignment tables, bump `sync_version`, and sync per §11.
- `GET /api/system/features` gains `scoped_access`.

## 11. Sync contract changes (contract-first, paired with osi-server)

The contract is designed and deployed before any edge producer emits. "Schema installed" (Phase A) is deliberately split from "events emitted" (Phase E): the edge image can ship the migrations with producers disabled until the cloud confirms acceptance.

**New aggregates and operations**, added to `docs/contracts/sync-schema/events.schema.json` and the byte-mirrored osi-server copy:

| Aggregate | Ops | Payload keys | Authority |
|---|---|---|---|
| `USER` | `USER_UPSERTED` | `user_uuid`, `username`, `role`, `disabled_at`, `sync_version`, `gateway_device_eui` | Edge → cloud only |
| `USER_ZONE_ASSIGNMENT` | upsert / delete (tombstone) | `assignment_uuid`, `user_uuid`, `zone_uuid`, `assigned_by_user_uuid`, `sync_version`, `deleted_at` | Edge → cloud only |
| `USER_PLOT_ASSIGNMENT` | upsert / delete (tombstone) | same shape with `plot_uuid` | Edge → cloud only |

Grant `sync_version` is bumped by writers on every mutation (migration 0003's pattern); the triggers read `NEW.sync_version`, giving the cloud a gap-detection signal per aggregate. `users.sync_version` exists from v1, and `USER_UPSERTED` carries it: the shipped `SyncEventTxExecutor` applies an unconditional per-resource watermark before handler dispatch and terminally rejects an equal-version payload change (`equal_version_payload_conflict`), so a versionless aggregate cannot exist on this transport. Tombstones replay idempotently: re-applying a delete is a no-op on a converged mirror. Cloud-originated grant edits are out of scope for v1 — grants are created by edge admins; a command path (`UPSERT_USER_GRANT` et al.) is the documented extension if cloud-side administration is ever wanted.

**Cloud identity model.** The cloud `User` keeps its global `USER`/`ADMIN`/`SUPER_ADMIN` role untouched. AgroLink role and enabled state are **per-gateway membership**, stored on or beside the existing `LinkedGatewayAccount` row (which already keys cloud user ↔ `gateway_device_eui` ↔ `local_user_uuid`): add `gateway_role` and `gateway_disabled_at`. A researcher who is admin on one hub holds no privilege on any other gateway. Cloud enforcement resolves the membership for the gateway being accessed, keys scope by the synced `local_user_uuid` and the mirrored assignment tables, and applies the same union rule as §4.

**Sequencing.** The osi-server PR (Flyway mirror tables, membership columns, event handlers, scoped query enforcement) merges and deploys first. Only then does an edge image enable the producers; without that ordering the cloud rejects unknown aggregates and events accumulate in `rejected_at`. A paired osi-server spec is produced in Phase E before any contract edit.

**Contract governance (folded in from Train A, Phase F).** The Phase F work ([`2026-07-15-cross-repo-sync-contract-ci.md`](../plans/2026-07-15-cross-repo-sync-contract-ci.md)) turns the implicit edge↔cloud HTTP contract into an explicit, versioned, edge-owned artifact with byte-compared vendored copies and CI on both repos. Once Phase F lands, this section's aggregates become governed schema rather than a handshake: adding `USER_UPSERTED` and the two assignment aggregates to `events.schema.json` follows Phase F's compatibility rule — additive edge schema/fixture first, additive server acceptance second, producer enablement only after capability proof. The `scoped_access_emit` gate (§5.2) is the SQL-level flip that the enablement step turns on. Two identity notions meet here and stay distinct: the protocol identity (`server-base + cloud-user + gateway-EUI`, hashed as `identitySha256` by the Phase G machinery) is a transport-scoped negotiation key, while scoped-access membership (`local_user_uuid` ↔ cloud user, per gateway) is an authorization fact; the `LinkedGatewayAccount` row is where they meet. Phase C's gate includes regenerating the Phase F producer fixture, because scoped provisioning (R2) changes the claim/register producer graph that the fixture inventories.

## 12. GUI changes

The React GUI reads `/api/me` at login and stores the scope profile alongside the token. Zone and plot pickers, dashboards, and history views render only in-scope resources; mutation controls (valve buttons, schedule editors, claim flows) render only where role and scope allow, and disappear for viewers. New admin screens: user list with role/disable controls, grant editor pairing users with zones and plots. When `scoped_access` is off the GUI renders as today. i18n keys go through the existing workflow (#47 covers the backlog).

## 13. Rollout and feature flag

Flag: `OSI_SCOPED_ACCESS` env/UCI, default off, surfaced in `/api/system/features`. With the flag off, request authorization behaves exactly as today; the schema gains columns and tables, audit gains the originator value, and sync payloads grow new aggregates only in Phase E — visible changes, but none that alter who can do what.

The AgroLink hub image sets the flag at provisioning. Fresh-hub bootstrap: the first registration on a scoped hub with zero admins becomes admin (§10); that admin creates all further accounts, because public registration is closed in scoped mode. In-place upgrade of an existing hub: operator runbook (backup, enable flag, restart Node-RED, confirm the §5.3 backfill promoted the intended account), not an automatic transition.

## 14. Testing

- Unit tests for `osi-scope-helper`: union rule (owner + grant), tombstoned grants, cache TTL, epoch invalidation on grant/role/disable writes, flag-off wildcard, fresh-vs-cached assert paths.
- Migration rehearsal: production-shaped DB copy with users, zones, plots, devices; apply 0022–0023; assert idempotent re-run. Fresh-image rehearsal: zero users, register first account, assert it becomes admin in one conditional write.
- Bootstrap adversarial tests: two concurrent first registrations on a fresh scoped hub produce exactly one admin (loser gets 409); disabling or de-roling the last enabled admin returns 409, including the two-admins-disable-each-other race; the CLI break-glass recovery is documented and rehearsed. Identifier-space test: the resolver maps `user_uuid → users.id` correctly, and legacy null-uuid rows are backfilled by 0023.
- USER-trigger ordering test: create an account through the trigger-assigned-uuid path and assert the emitted `USER_UPSERTED` payload's `user_uuid` is non-null (guards the three-arm shape in §5.2 against the sibling-trigger invisibility reproduced during review).
- Scheduler-authority tests: schedule mutation rejected for out-of-scope users; execution clears `enabled` when the zone's in-scope enabled-account set empties (disable, revocation, de-provision), and only then.
- **Restart-reversion test:** apply migrations, restart the flow runtime, assert all migration-owned triggers still exist with their migration bodies (guards the §5.1 invariant against regression).
- Behavioral matrix, mandatory per write endpoint: admin / researcher / viewer / disabled × own scope / foreign scope × flag on/off, plus every R1–R6 rule, especially R5 foreign-enumeration denial and §8 scheduler-origin forgery attempts.
- Concurrency smoke: cold-cache `resolveScope` under a dozen concurrent dashboard readers, timed on Pi-class hardware (validates app-level enforcement overhead before Phase C).
- GUI unit tests for scoped rendering and viewer mode (`npm run test:unit`).
- Paired cloud tests per osi-server conventions before producers are enabled.

## 15. Phasing

| Phase | Deliverable | Gate |
|---|---|---|
| A | Migrations 0022–0023, `osi-scope-helper`, flag, `/api/me`, bootstrap registration, verifiers incl. `MIGRATION_OWNED_TRIGGERS` | Migration gates green; fresh-image and in-place rehearsals pass; restart-reversion test green |
| B | Read-path enforcement (lists, history, exports, shared-env exception) | Behavioral matrix green for read endpoints |
| C | Write-path enforcement, scheduler authority, audit attribution, R1–R6 | Crafted-request tests green; `applied_commands.originator` populated; revocation measured immediate on actuation; Phase F producer fixture regenerated for the scoped claim graph |
| D | GUI scoping, admin screens, viewer mode | GUI unit tests; build green |
| F | Edge-owned sync HTTP contract + cross-repo CI (folded Train-A hardening; source plan [`2026-07-15-cross-repo-sync-contract-ci.md`](../plans/2026-07-15-cross-repo-sync-contract-ci.md)) | Edge fixture + vendored-byte CI green on both repos; zero live-host access |
| E | Paired osi-server spec + PR (mirror tables, membership, event handlers, cloud enforcement); governed contract schema updates per Phase F's compatibility rule; then edge producers enabled | Cloud accepts aggregates; scoped remote login verified |
| G | Witnessed-ledger / sync-protocol activation (folded Train-A hardening; source plan [`2026-07-15-sync-delivery-stop-loss.md`](../plans/2026-07-15-sync-delivery-stop-loss.md) Tasks 3–4 + `osi-sync-protocol-state` machinery) | Derived sub-plan passes its own adversarial review; v2 no-regression proof |

Dependencies: A → B → C → D is the edge spine. F follows A, runs in parallel with B–D, and must complete before E (E's aggregates enter the contract F governs). G is last and hard-ordered after F: its v3 capability proof hashes F's fixture bytes, and its witness registry inventories the producer graph only after C has finalized it. F has one external prerequisite: the Train A integration branch merged to main (its fixture derives from the shipped post-Train-A function graph).

**Phase G scope summary** (the reverted "giant," narrowed to what remains after Train A's shipped fail-closed delivery and `applied_commands` dedup): the append-only command-activity audit ledger (own `activity.sqlite`, never `farming.db`), v2/v3 negotiation with the per-linked-identity capability state machine, database-restore reconciliation, and the `INTENT_PERSISTED` crash-safety boundary (`persistExternalIntent` / `completeIdempotentExternalEffect` / `queueExternalIntentRetry` / `db.durableTransaction`) around external effects such as ChirpStack registration. Audit layering stays as §9 defines it: `applied_commands.originator` remains the queryable attribution surface, the activity ledger is the tamper-evident witness, and scoped mode supplies real actor uuids to the ledger's local-principal hashes. G's negotiation gate (command polling) and this design's emit gate (event emission, §5.2) are independent and must not be conflated.

**Out of scope for both folded phases:** deploy.sh activation wiring, CI workflow unions, factory-image provenance, the deployment-state machine and Train-A artifact builders, image builds and tags, live deploys and any live-host access (Kaba100, test server, `osicloud.ch`), v2 retirement, MQTT path changes (`MqttPublisherService` stays deprecated), and cloud-originated grant commands (§11's extension note stands).

Phases A–D are edge-only and ship behind the flag with producers disabled. Phase E is cross-repo and sequenced cloud-first per §11.

## 16. Open questions for the plan phase

- Exact payload columns for the three aggregates, matched against osi-server canonicalization expectations when the paired spec is written (Phase E, not blocking A–D).
- Whether researcher-created zones need an admin-set water-budget ceiling to protect shared pressure infrastructure; deferred until Agroscope confirms trial layouts.
- Grant expiry (time-boxed access for visiting students) — not in v1; the tombstone model supports it later without schema change.

## 17. Revision history

- **v7 (2026-07-22):** Task 12 fix wave, driven by the Phase A boot-ddl gate blocking on `verify-boot-ddl-interpolation.js`. Root cause: the shipped `SyncEventTxExecutor` applies an unconditional per-resource watermark before handler dispatch, and the three USER triggers (§5.2) emitted literal `0` as `sync_version`; the first `USER_UPSERTED` set the cloud watermark to 0, then every later role or disable change hashed differently at the same version and was rejected as `equal_version_payload_conflict` — a disabled user would stay enabled for cloud access forever. Fix: `users` gains a `sync_version` column (§5.2), the three USER triggers emit `NEW.sync_version` instead of the literal, and `USER_UPSERTED` carries `sync_version` (§11). §5.2's trigger-bump sentence was also wrong and is corrected here: no trigger bumps `sync_version` itself; the writer bumps it in the same statement that changes the row.
- **v6 (2026-07-20):** implementation-plan review round. Fixed a logic bug in §10's illustrative last-enabled-admin guard SQL, confirmed by reproduction: the guard's admin-count subquery was unconditional on the target row, so disabling *any* account — not just an admin — was refused whenever exactly one admin was enabled (the common post-bootstrap state). Added the `role != 'admin'` short-circuit so the count check applies only when the target is itself an admin. Also added a note to §5.2 confirming (empirically, against both `node:sqlite` and the on-device `sqlite3` binding) that Arm 1's cross-trigger cascade is unaffected by SQLite's default `recursive_triggers=OFF`, since that pragma suppresses only self-recursion. The Phase A–D implementation plans separately fixed a real admin-scope-bypass inconsistency this spec did not itself contain (Phase C's `assertFreshDeviceAccess` had drifted from §6's "owned + granted" rule for admin) and closed a scope-enforcement visibility gap in the journal/history read paths — see those plans' own histories.
- **v5 (2026-07-19):** folded in the two deferred Train-A hardening efforts as Phases F and G (§15) with dedupe against this design: §11's hand-rolled coordination language superseded by Phase F's contract compatibility rule; audit layering stated against the witness ledger; protocol identity vs membership identity disambiguated; Phase C gate gains producer-fixture regeneration; emit gate vs negotiation gate kept independent. Out-of-scope boundaries recorded (§15). Phase A is unaffected.
- **v4 (2026-07-19):** folded in the fourth external review. Changes: `USER` aggregate rebuilt as a three-arm trigger — a bare INSERT arm would emit a null `user_uuid` because sibling-trigger UPDATEs are invisible to other AFTER INSERT triggers (reproduced against SQLite); the uuid-filled arm fires on AFTER UPDATE OF user_uuid (§5.2). Last-enabled-admin guard is a single conditional write covering disable, de-role, and deletion (§10). Schedule policy stated explicitly: collective zone infrastructure, flagged for admin re-confirmation on any scope change (§8). Migration 0023's dual purpose (uuid backfill + admin promotion) stated once (§5.3).
- **v3 (2026-07-19):** folded in the third external review (first content review of the v2 additions). Changes: scheduler authority rebuilt on zone scope — the v2 text keyed on a creator column that does not exist (§4, §8); `USER` aggregate fires on INSERT so users precede grants (§5.2); bootstrap is a single conditional write and the last enabled admin cannot be disabled, with a CLI break-glass (§10); schedule-disable triggers on loss of scope, not loss of a grant row (§8); the resolver's `user_uuid → users.id` bridge and the 0023 uuid backfill are explicit (§8); check-to-enqueue race narrowed to the serialized writer (§8).
- **v2 (2026-07-19):** folded in two external reviews. Changes: ownership/grant union model (§4); trigger invariant and migration-owned-trigger strategy (§5.1); registration-time bootstrap replacing the lowest-id heuristic (§10, §13); uncached physical-effect checks and scheduler authority (§8); contract-first sync with per-gateway cloud membership (§11); reverse indexes, R4 implementation detail, R6; ratchet demoted to necessary-not-sufficient (§5.4, §14); flag-off claim narrowed (§13).
- v1 (2026-07-19): initial approved direction.
