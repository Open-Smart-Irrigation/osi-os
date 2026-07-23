# AgroLink scoped access Phase E implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror gateway-local users and grants in OSI Server, enforce
per-gateway roles, and support edge-approved cloud administration without
enabling either runtime direction before deployment.

**Architecture:** Normalized mirror tables feed one `GatewayScopeService`.
Cloud changes reuse `DesiredStateService` and REST pending commands. New edge
commands apply through a focused helper and the existing command ledger. The
edge remains canonical.

**Tech Stack:** PostgreSQL 16, Flyway, Java 21/Spring Boot/JPA, React and
TypeScript, SQLite, Node-RED, governed JSON Schema contracts.

---

### Task 1: Govern access command contracts

**Files:**
- Modify: `docs/contracts/sync-schema/commands.schema.json`
- Modify: `docs/contracts/sync-schema/resources.schema.json`
- Modify: `docs/contracts/sync-schema/sync-contract-golden.json`
- Modify: `scripts/test-contract-schemas.js`
- Modify: `scripts/verify-sync-contract.js`
- Modify: `scripts/verify-sync-op-parity.js`

- [ ] Add the six command types from the paired spec. Require canonical UUIDs,
  a non-negative `base_sync_version`, a stable `effect_key`, and exactly one
  command-specific resource body.
- [ ] Define user and assignment resource shapes. Keep passwords out of all
  resource definitions; permit only `password_hash` on the two user credential
  command payloads.
- [ ] Add positive fixtures and negative fixtures for a stale/missing base,
  malformed UUID, invalid role, missing tombstone identity, and plaintext
  password fields.
- [ ] Keep `scoped_access_sync_v1.edgeProducerEnabled=false` and add
  `scoped_access_commands_v1` with issuer disabled.
- [ ] Run:

```bash
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
node scripts/verify-sync-op-parity.js
node scripts/verify-communication-contract.js
```

- [ ] Commit as `feat(contract): govern scoped access commands`.

### Task 2: Add server mirrors and membership fields

**Files:**
- Create: `backend/src/main/resources/db/migration/V2026_07_23_003__scoped_access_mirrors.sql`
- Create: `backend/src/main/java/org/osi/server/scopedaccess/GatewayUserMirror.java`
- Create: `backend/src/main/java/org/osi/server/scopedaccess/GatewayUserMirrorRepository.java`
- Create: `backend/src/main/java/org/osi/server/scopedaccess/UserZoneAssignmentMirror.java`
- Create: `backend/src/main/java/org/osi/server/scopedaccess/UserZoneAssignmentMirrorRepository.java`
- Create: `backend/src/main/java/org/osi/server/scopedaccess/UserPlotAssignmentMirror.java`
- Create: `backend/src/main/java/org/osi/server/scopedaccess/UserPlotAssignmentMirrorRepository.java`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccount.java`
- Test: `backend/src/test/java/org/osi/server/scopedaccess/ScopedAccessMigrationIT.java`

- [ ] Write the migration integration test first. Assert all three tables,
  composite unique constraints, active-grant indexes, and
  `linked_gateway_accounts.gateway_role/gateway_disabled_at`.
- [ ] Run the focused test and retain the expected missing-relation failure.
- [ ] Add Flyway DDL and JPA entities. Roles are strings constrained to
  `admin`, `researcher`, or `viewer`; mirror versions are positive.
- [ ] Run the focused migration test with the guarded Gradle command.
- [ ] Commit as `feat(sync): add scoped access mirrors`.

### Task 3: Apply scoped mirror events

**Files:**
- Create: `backend/src/main/java/org/osi/server/scopedaccess/ScopedAccessMirrorService.java`
- Create: `backend/src/main/java/org/osi/server/sync/GatewayUserApplier.java`
- Create: `backend/src/main/java/org/osi/server/sync/UserZoneAssignmentApplier.java`
- Create: `backend/src/main/java/org/osi/server/sync/UserPlotAssignmentApplier.java`
- Modify: `backend/src/main/java/org/osi/server/sync/SyncEventTxExecutor.java`
- Test: `backend/src/test/java/org/osi/server/scopedaccess/ScopedAccessMirrorServiceTest.java`
- Test: `backend/src/test/java/org/osi/server/sync/ScopedAccessEventApplierTest.java`

- [ ] Write tests for user upsert, linked-membership refresh, assignment
  upsert/delete, tombstone-first delivery, missing-user retry, replay, stale
  version, equal-version/different-payload rejection, and the accepted
  first-assignment-only UUID trigger (no equal-version no-op `USER_UPSERTED`
  duplicate).
- [ ] Add mirror service methods that validate gateway and aggregate identity,
  store canonical JSON, and update matching linked-account fields.
- [ ] Add one applier per resource family. Extend the transaction executor's
  parent-missing classifier to recognize a missing scoped user.
- [ ] Run focused tests, then the server vendor and sync-event selections.
- [ ] Commit as `feat(sync): apply scoped access events`.

### Task 4: Resolve and enforce gateway scope

**Files:**
- Create: `backend/src/main/java/org/osi/server/scopedaccess/GatewayScope.java`
- Create: `backend/src/main/java/org/osi/server/scopedaccess/GatewayScopeService.java`
- Modify: `backend/src/main/java/org/osi/server/journal/JournalAccessService.java`
- Modify: `backend/src/main/java/org/osi/server/zone/IrrigationZoneController.java`
- Modify: gateway-scoped device, history, analysis, valve, and schedule
  controllers identified by `rg "gateway(Device)?Eui|LinkedGatewayAccount"`
- Test: `backend/src/test/java/org/osi/server/scopedaccess/GatewayScopeServiceTest.java`

- [ ] Write scope tests for ownership plus grants, foreign 404, viewer 403 on
  mutation, disabled 403, admin wildcard, and one cloud user holding admin on
  gateway A and viewer on gateway B.
- [ ] Resolve the linked account, current user mirror, owned resources, and
  active grants. Do not consult `User.role`.
- [ ] Replace owner-only journal access with gateway scope and apply the same
  service to portable gateway-scoped controllers. Preserve edge checks as the
  final authority on queued mutations.
- [ ] Run focused controller tests and the complete backend test suite.
- [ ] Commit as `feat(auth): enforce per-gateway scoped access`.

### Task 5: Issue desired access commands

**Files:**
- Modify: `backend/src/main/java/org/osi/server/desiredstate/DesiredStateMutationKind.java`
- Modify: `backend/src/main/java/org/osi/server/desiredstate/DesiredStateService.java`
- Create: `backend/src/main/java/org/osi/server/scopedaccess/ScopedAccessMutationService.java`
- Create: `backend/src/main/java/org/osi/server/scopedaccess/ScopedAccessController.java`
- Test: `backend/src/test/java/org/osi/server/scopedaccess/ScopedAccessMutationServiceTest.java`
- Test: `backend/src/test/java/org/osi/server/scopedaccess/ScopedAccessControllerTest.java`

- [ ] Add an ACK-only credential mutation kind. Test that only this kind
  becomes applied on an `APPLIED` ACK without a mirror.
- [ ] Write mutation tests for user create/update/disable/re-enable, password
  reset, grant/revoke, last-admin rejection, base conflict, and offline
  pending state.
- [ ] Build desired resources from canonical mirrors. Hash temporary passwords
  with the configured `PasswordEncoder`, place only the hash in the command
  payload, and never place it in desired JSON.
- [ ] Require fresh gateway admin scope before every mutation. Return canonical
  plus desired and operation state.
- [ ] Run focused and full backend tests.
- [ ] Commit as `feat(admin): queue scoped access changes`.

### Task 6: Apply access commands on the edge

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scoped-access-commands.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-scoped-access-commands.js`
- Create: `scripts/migrate-flows-scoped-access-commands.js`
- Modify: both maintained `flows.json` files through that script only
- Create: `scripts/test-scoped-access-command-path.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

- [ ] Write lifecycle tests for apply, replay, stale base, malformed resource,
  last-admin protection, grant delete, and credential ACK with no secret in
  the ledger result.
- [ ] Implement one helper that applies all six commands in a transaction,
  checks `base_sync_version`, increments the canonical version, invalidates
  the shared scope cache, and returns stable ACK facts.
- [ ] Add registry entries and one guarded flow dispatch node through the
  one-shot migration script. Preserve the protected delivery envelope.
- [ ] Run helper tests and every flow parse, wiring, size, bare-require,
  silent-catch, profile-parity, scoped write, and sync-flow gate.
- [ ] Commit as `feat(sync): apply scoped access commands`.

### Task 7: Cloud administration UI

**Files:**
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types/farming.ts`
- Create: `frontend/src/pages/GatewayAccessAdminPage.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/pages/__tests__/GatewayAccessAdminPage.test.tsx`

- [ ] Write tests for gateway switching, mirrored users/grants, pending
  overlays, conflict recovery, rejected state, disabled membership, and
  different roles on two gateways.
- [ ] Add typed service normalization for canonical, desired, and operation
  responses.
- [ ] Build the admin page with user and grant workflows. Hide it unless the
  selected gateway's confirmed role is admin.
- [ ] Run frontend typecheck if present, unit tests, and build.
- [ ] Commit as `feat(ui): administer gateway access`.

### Task 8: Vendor, verify, and stop at activation boundary

**Files:**
- Update server contract vendor files under
  `backend/src/test/resources/sync-contract/`
- Modify: `docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-execution-report.md`

- [ ] Copy canonical contract files byte-for-byte to the server vendor.
- [ ] Run the paired contract gates, edge scope/flow suites, full server
  backend suite, server frontend suite, and builds after the memory gate.
- [ ] Confirm scoped event producer and command issuer enablement remain false.
- [ ] Record that production acceptance deployment and live capability
  activation were skipped because the autonomous program forbids production
  and live-gateway access.
- [ ] Push both branches. Do not flip a live flag or report end-to-end success.
