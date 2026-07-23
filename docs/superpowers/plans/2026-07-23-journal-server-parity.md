# Journal server parity implementation plan

> Execute in `/home/phil/Repos/osi-server/.worktrees/agrolink` on `AgroLink`.
> Use TDD for each implementation slice. Run Gradle with `--no-daemon
> --max-workers=2` and set `NODE_OPTIONS=--max-old-space-size=2048` whenever a
> Gradle task may build a frontend.

**Goal:** Mirror the five canonical edge journal events and issue the five
canonical journal commands with durable desired-state feedback.

**Architecture:** Four PostgreSQL mirror tables keep indexed ownership and
timeline fields beside the complete contract aggregate. Dedicated sync
appliers call a shared mirror service. One controller and mutation service
authorize a selected gateway, build trusted edge command payloads, and reuse
the desired-state ledger. A compact React workspace consumes normalized API
models.

## Task 1: Mirror schema

**Files**

- Create
  `backend/src/main/resources/db/migration/V2026_07_23_002__journal_mirrors.sql`
- Create
  `backend/src/test/java/org/osi/server/journal/JournalMirrorMigrationIT.java`
- Modify `LinkedGatewayAccount` and its capability mapping tests

1. Write a Testcontainers test asserting all four tables, JSONB columns,
   unique keys, owner/gateway indexes, entry timeline index, tombstone
   preservation, and the `field_journal_v1` linked-account capability.
2. Run the test and confirm that it fails because the migration is absent.
3. Add the Flyway migration.
4. Run the focused test and commit.

## Task 2: Event appliers

**Files**

- Create `backend/src/main/java/org/osi/server/journal/JournalMirrorService.java`
- Create four `Journal*Applier.java` classes in the sync package
- Create `backend/src/test/java/org/osi/server/journal/JournalMirrorReplayIT.java`
- Modify sync dispatcher tests as required

1. Add failing tests for all five operations, complete aggregate preservation,
   duplicate delivery, stale delivery, equal-version conflict, entry void, and
   resource tombstones.
2. Implement strict key, gateway, owner, version, and status checks.
3. Upsert the selected index columns and complete `aggregate_json` in the
   current sync transaction.
4. Run focused replay and dispatcher tests, then commit.

## Task 3: Journal command service

**Files**

- Create `backend/src/main/java/org/osi/server/journal/JournalAccessService.java`
- Create `backend/src/main/java/org/osi/server/journal/JournalMutationService.java`
- Create `backend/src/main/java/org/osi/server/journal/JournalView.java`
- Create `backend/src/test/java/org/osi/server/journal/JournalMutationServiceTest.java`
- Modify `backend/src/main/java/org/osi/server/command/CommandService.java`
- Modify its focused tests

1. Add failing tests for trusted identity overwrite, every effect-key form,
   all five command payloads, unleased continued editing, leased supersession,
   and void.
2. Implement owner-only gateway and resource hooks without consulting global
   role.
3. Build exact snake-case edge command resources and call
   `DesiredStateService.request`.
4. Keep legacy `commandType` injection for legacy payloads but omit it when a
   canonical `command_type` is already present.
5. Return the desired resource and operation separately.
6. Run focused mutation, command, and desired-state tests, then commit.

## Task 4: API, exports, and recovery

**Files**

- Create `backend/src/main/java/org/osi/server/journal/JournalController.java`
- Create `backend/src/main/java/org/osi/server/journal/JournalExportService.java`
- Create `backend/src/test/java/org/osi/server/journal/JournalControllerTest.java`
- Create `backend/src/test/java/org/osi/server/journal/JournalExportTest.java`

1. Add failing authorization, list, filter, create, update, void, retry, and
   rejection-recovery tests.
2. Implement the gateway-scoped routes in the design.
3. Add deterministic JSON and formula-safe CRLF CSV export.
4. Compare controller command payloads and exported resource fields with the
   vendored edge contract fixtures.
5. Run focused controller and export tests, then commit.

## Task 5: Contract rollout

**Files**

- Modify the edge canonical golden contract and server vendor
- Modify edge/server contract verification tests where the enablement lists
  are pinned

1. Add a failing gate proving the five journal events and commands are still
   staged.
2. Move only those ten operations from `staged` to `enabled`.
3. Vendor the exact edge bytes to the server.
4. Run edge schema and operation-parity gates plus the server vendor test.
5. Commit edge and server changes separately.

## Task 6: Frontend API and workspace

**Files**

- Modify `frontend/src/services/api.ts`
- Create `frontend/src/types/journal.ts`
- Create `frontend/src/pages/JournalPage.tsx`
- Create journal components and focused tests
- Modify `frontend/src/App.tsx`, navigation, route tests, and locale catalogs

1. Add failing tests for snake/camel normalization, canonical-versus-desired
   rendering, pending/conflict/rejected states, continued edit, retry, void,
   plot and group editing, filters, and exports.
2. Implement the API adapter and compact responsive workspace.
3. Reuse `PendingStateNotice`; do not duplicate desired-state labels.
4. Add accessible navigation and all supported locales.
5. Run frontend unit tests and build, then commit.

## Task 7: Acceptance and paired publication

1. Sample memory before each heavyweight command.
2. Run focused journal backend tests.
3. Run the complete backend suite with the guarded Gradle command.
4. Run server frontend unit tests and guarded build.
5. Run edge contract, schema, journal API, journal command, and sync-flow gates.
6. Review both cumulative diffs for scope, generated output, configuration,
   credentials, and production references.
7. Update the orchestrator execution report with commands, memory samples,
   commit SHAs, and any explicit deferrals.
8. Commit and push each repository only after its relevant gates are green.
