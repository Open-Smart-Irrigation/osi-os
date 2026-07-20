# AgroLink Scoped Access — Phase E Implementation Plan (Cloud Contract + Enforcement)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three scoped-access aggregates flow edge→cloud through the governed contract; osi-server mirrors grants, holds per-gateway membership, and enforces the same scoped model for remote researcher access.

**Architecture:** Per edge spec §11 and the paired cloud spec [`2026-07-19-agrolink-scoped-access-osi-server.md`](../specs/2026-07-19-agrolink-scoped-access-osi-server.md). Cloud-first deployment per the Phase F compatibility rule: the contract schema change lands on the edge first (additive, no producers), the server PR merges and deploys accepting the new aggregates, and only then does an operator flip `scoped_access_emit=1` on the hub. Load `osi-sync-contract-awareness` (contract edits) and `osi-server-backend-patterns` (server tasks) before starting.

**Tech Stack:** Edge: `docs/contracts/sync-schema/**` + vendored mirrors. Cloud: Java 21/Spring Boot, Flyway, PostgreSQL 16, JUnit 5, Gradle.

**Prerequisites:** Phase F complete (contract CI live; vendored byte-compare gate exists on the server). Phases A–D merged. Train A integration merged to `osi-os/main`.

**Cross-repo PR rule:** paired branches/PRs; each PR states contract files changed, mirror-update status, where the paired PR lands, and which edge/server verification commands ran. Never cross-commit between repos.

---

## Task E1: Contract schema additions (edge, osi-os)

**Files:**
- Modify: `docs/contracts/sync-schema/events.schema.json`
- Modify: `docs/contracts/sync-schema/resources.schema.json`
- Modify: `docs/contracts/sync-schema/README.md` (aggregate list)

- [ ] **Step 1: Add the ops to the enum**

In `events.schema.json`, append to the `op` enum (keep alphabetical neighbors intact):

```json
"USER_UPSERTED",
"USER_ZONE_ASSIGNMENT_DELETED",
"USER_ZONE_ASSIGNMENT_UPSERTED",
"USER_PLOT_ASSIGNMENT_DELETED",
"USER_PLOT_ASSIGNMENT_UPSERTED",
```

- [ ] **Step 2: Add resource definitions**

In `resources.schema.json`, add `SyncUserUpsert`, `SyncUserZoneAssignment`, `SyncUserPlotAssignment` definitions with exactly the payload keys from the paired spec §2 (all camelCase in payload per the trigger bodies: `user_uuid` etc. stay snake_case **inside payloads**, matching every existing trigger payload — verify against one existing definition before writing; do not invent a new casing convention).

- [ ] **Step 3: Validate**

```bash
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
node scripts/verify-sync-op-parity.js
```
Expected: exit 0. If `verify-sync-op-parity` maps ops to cloud handlers, extend its allowlist/table with the three aggregates and their ops.

- [ ] **Step 4: Commit (edge contract PR, merges first)**

```bash
git add docs/contracts/
git commit -m "feat(contract): scoped-access aggregates (USER + grant assignments)"
```

---

## Task E2: Server schema + mirror tables (osi-server)

**Files:**
- Create: `backend/src/main/resources/db/migration/V<next>__agrolink_gateway_membership.sql` (exact SQL from paired spec §3)
- Create: `backend/src/main/java/org/osi/server/user/UserZoneAssignmentMirror.java` + repository
- Create: `backend/src/main/java/org/osi/server/user/UserPlotAssignmentMirror.java` + repository
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccount.java` (`gatewayRole`, `gatewayDisabledAt`)

- [ ] **Step 1: Flyway migration + catalog test**

Apply the paired spec §3 SQL verbatim (choose the next `V<next>` from `ls backend/src/main/resources/db/migration/`). Extend the migration catalog test to assert: both columns with CHECK, both mirror tables, four partial indexes.

- [ ] **Step 2: Entities + repositories**

Map both mirror tables and the two new `LinkedGatewayAccount` fields following the existing entity conventions in the `user` package (builder, JPA annotations, no business logic in entities).

- [ ] **Step 3: Test + commit**

```bash
cd backend && ./gradlew test --no-daemon -x buildFrontend -x buildTerraIntelligenceFrontend \
  --tests '*FlywayMigrationIT'
git add backend/
git commit -m "feat(sync): gateway membership columns + grant mirror tables"
```

---

## Task E3: Server event handlers

**Files:**
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java` (op dispatch)
- Create: `backend/src/main/java/org/osi/server/sync/ScopedAccessEventApplier.java` + test
- Modify: `backend/src/test/resources/sync-contract/events.schema.json` (vendored byte-copy of the Task E1 file)

- [ ] **Step 1: Vendor the updated contract**

```bash
cp ../osi-os/docs/contracts/sync-schema/events.schema.json \
   backend/src/test/resources/sync-contract/events.schema.json
# resources.schema.json likewise if E1 added definitions there
```

The Phase F vendor CI enforces byte identity from here on; any drift fails server CI.

- [ ] **Step 2: Applier**

`ScopedAccessEventApplier` implements the paired spec §4 semantics: `USER_UPSERTED` → membership upsert on `(gateway_device_eui, user_uuid)` with `unknown_local_user` retryable; grant upserts apply when `sync_version` is newer; deletes tombstone idempotently. Wire the three cases into the existing `switch (event.op())`, returning the shipped result types (`APPLIED` / `DUPLICATE` / `RETRYABLE_ERROR` / `REJECTED`).

- [ ] **Step 3: Handler tests**

Happy path, replay idempotency, unknown-user retry converges after membership row arrives, stale version rejected, tombstone replay → `DUPLICATE`, malformed payload → `REJECTED`. Run the named selections, then the full backend gate:

```bash
cd backend && ./gradlew test --no-daemon -x buildFrontend -x buildTerraIntelligenceFrontend \
  --tests '*ScopedAccessEventApplier*' --tests '*EdgeSync*'
cd backend && ./gradlew test --no-daemon -x buildFrontend -x buildTerraIntelligenceFrontend
```

- [ ] **Step 4: Commit**

```bash
git add backend/
git commit -m "feat(sync): apply scoped-access aggregates (membership + grant mirrors)"
```

---

## Task E4: Server enforcement for remote researchers

**Files:**
- Modify: the controllers/services serving gateway-scoped researcher reads (zone/device/history dashboards) and command-enqueue paths (`VALVE_COMMAND`, schedule/config upserts) — identify exact classes during execution with a blast-radius grep for `LinkedGatewayAccount` consumers; record in the execution report
- Create: `backend/src/main/java/org/osi/server/user/GatewayScopeService.java` + test

- [ ] **Step 1: `GatewayScopeService`**

```java
public GatewayScope resolve(User cloudUser, String gatewayEui) { ... }
// membership: LinkedGatewayAccount(gatewayEui, cloudUser) -> localUserUuid, gatewayRole, gatewayDisabledAt
//   missing row or disabled -> 403
// scope: owned zones (existing mirrors) UNION user_zone_assignments_mirror grants; plots likewise
// methods: boolean zoneVisible(String zoneUuid), boolean plotVisible(String plotUuid),
//          void assertZone(String zoneUuid) -> 404, void assertRole(String role) -> 403
```

- [ ] **Step 2: Apply to read + command paths**

Read endpoints filter through `GatewayScope`; command-enqueue paths assert the target zone before queueing a pending command (the edge re-checks on application; the cloud check is UX/early rejection, never the authority).

- [ ] **Step 3: Enforcement tests**

Per paired spec §7: own-zone 200, foreign 404, viewer command 403, disabled membership 403, gateway-admin full, `SUPER_ADMIN` unaffected. Full backend gate green.

- [ ] **Step 4: Commit + server PR merge + deploy**

```bash
git add backend/
git commit -m "feat(sync): per-gateway scoped enforcement for researcher access"
```

The server PR states: contract files consumed (vendored, byte-identical), paired edge PR (`feat(contract): scoped-access aggregates`), and the verification commands run. Deploy the server change before Task E5.

---

## Task E5: Enable edge producers on the AgroLink hub (operator step)

**Files:** none (live operation; the runbook entry is the artifact)

- [ ] **Step 1: Pre-flight**

Confirm: server deployed with Task E3+E4; edge image with Phase A–E schema installed is flashed on the hub; `scoped_access_emit` reads `enabled=0`.

- [ ] **Step 2: Enable and verify**

```bash
sqlite3 /data/db/farming.db "UPDATE scoped_access_emit SET enabled=1 WHERE id=1;"
sqlite3 /data/db/farming.db "SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='USER';"
```

Create one test grant via the admin API; confirm: one `USER_ZONE_ASSIGNMENT_UPSERTED` row in the edge outbox, delivery without `rejected_at`, the mirror row on the server, and a scoped remote login seeing exactly the granted zone.

- [ ] **Step 3: Rollback path**

`UPDATE scoped_access_emit SET enabled=0 WHERE id=1;` stops emission immediately; delivered rows stay mirrored harmlessly. Record the operator runbook entry under `docs/operations/`.

---

## Task E6: Phase E gate

- [ ] Contract schemas green on both repos; vendored copies byte-identical (Phase F CI proves it continuously).
- [ ] Full backend suite green; `verify-sync-contract.js`, `test-contract-schemas.js`, `verify-sync-op-parity.js`, `verify-sync-flow.js` green on the edge.
- [ ] Acceptance per spec §15: cloud accepts all three aggregates; scoped remote login verified end-to-end on the hub.

## Notes for the executor

- Payload key casing follows the existing trigger payloads (snake_case inside `payload_json`); the v3 HTTP envelope camelCase convention from the Phase F fixture applies to transport envelopes, not to event payloads. Check one existing aggregate's definition before writing any schema line.
- If Phase F has not landed when this phase starts, stop: E without the governed contract reintroduces exactly the drift F exists to prevent.
- Grant events must never be enabled before the server accepts them — that is the entire reason `scoped_access_emit` exists; E5 is the only task that flips it, and it is an operator step with a documented rollback.
