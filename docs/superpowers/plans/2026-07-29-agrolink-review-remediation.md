# AgroLink review remediation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the command-safety, identity, scope, desired-state presentation, recovery, and schema-parity defects found in the independent AgroLink edge/cloud review.

**Architecture:** Keep the edge authoritative. The server must not deliver expired physical effects, cloud journal reads and writes must use the same owner-plus-grant scope as the edge, and recovery must use fresh gateway-admin authority plus row-locked state transitions. Edge identity checks retain the immutable token subject, history ACKs map submitted keys back to stored dirty keys, and the GUI distinguishes an explicit flag-off profile from a failed scope lookup.

**Tech Stack:** Node-RED JSON flows, Node.js tests, SQLite migrations, React/TypeScript/Vitest, Spring Boot 3.4/JPA/JUnit, PostgreSQL/Flyway.

---

## File map

### OSI OS

- `scripts/test-command-expiry-path.js`: guard that the edge rejects elapsed command envelopes before normal dispatch.
- `scripts/test-device-api-auth-status.js`: immutable token-subject regression for `/api/me`.
- `scripts/test-scoped-access-reads.js`: username-reuse regressions for scoped history, zone, and device read surfaces.
- `scripts/test-sync-history-worker.js`: old-EUI dirty-key to current-EUI submitted-key ACK regression.
- `scripts/verify-runtime-schema-parity.js`: migration-owned trigger registry.
- `web/react-gui/src/contexts/ScopeContext.tsx`: explicit loading, resolved, and failed scope states.
- `web/react-gui/src/contexts/__tests__/ScopeContext.test.tsx`: fail-closed profile-fetch regression.
- `web/react-gui/src/components/ScopeStatusBanner.tsx`: visible retry action for a failed scope lookup.
- `web/react-gui/src/components/__tests__/ScopeStatusBanner.test.tsx`: rejection-to-retry recovery regression.
- `web/react-gui/src/App.tsx`: mount the scope-status consumer inside `ScopeProvider`.
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`: canonical `/api/me`, history authorization, dirty-history ACK, and command-expiry flow changes.
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`: byte-identical maintained-profile mirror.

### OSI Server

- `backend/src/main/java/org/osi/server/command/DeviceCommandRepository.java`: atomic legacy pending-command selection and expiry.
- `backend/src/main/java/org/osi/server/command/CommandService.java`: legacy pending-command expiry transaction.
- `backend/src/test/java/org/osi/server/command/DeviceCommandRepositoryDbTest.java`: protocol-v1 expiry regression.
- `backend/src/test/java/org/osi/server/command/CommandServiceTest.java`: expired rows become terminal before response construction.
- `frontend/src/services/api.ts`: pending-only desired-state overlays for devices and journal resources.
- `frontend/src/services/__tests__/api.deviceParity.test.ts`: device desired-state status matrix.
- `frontend/src/services/__tests__/api.journal.test.ts`: journal desired-state status matrix.
- `backend/src/main/java/org/osi/server/journal/JournalQueryService.java`: gateway-scope-aware journal reads.
- `backend/src/main/java/org/osi/server/journal/JournalAccessService.java`: target-resource read/write authorization.
- `backend/src/main/java/org/osi/server/journal/JournalController.java`: pass resolved scope to reads, exports, and mutations.
- `backend/src/test/java/org/osi/server/journal/JournalControllerTest.java`: granted/admin/foreign-resource controller cases.
- `backend/src/test/java/org/osi/server/journal/JournalQueryServiceTest.java`: owner-plus-grant SQL behavior.
- `backend/src/main/java/org/osi/server/user/GatewayInstallationRepository.java`: pessimistic installation-row lookup.
- `backend/src/main/java/org/osi/server/recovery/RecoveryOperationRepository.java`: pessimistic operation-row lookup.
- `backend/src/main/java/org/osi/server/recovery/RecoveryOperationService.java`: current-operation ownership and receipt binding.
- `backend/src/main/java/org/osi/server/recovery/RecoveryOperationController.java`: gateway-admin HTTP prechecks for recovery actions and audit.
- `backend/src/main/java/org/osi/server/recovery/RecoveryBundleService.java`: fresh gateway-admin authorization for human bundle access.
- `backend/src/main/java/org/osi/server/recovery/RecoveryReceiptVerifier.java`: canonical reconciliation-receipt validation.
- `backend/src/main/java/org/osi/server/recovery/LocalHmacRecoveryReceiptVerifier.java`: property-gated local/test receipt proof independent of sync and operation tokens.
- `backend/src/main/resources/db/migration/V2026_07_29_001__recovery_receipt_binding.sql`: durable prepare-receipt and receipt-proof fields.
- `backend/src/test/java/org/osi/server/recovery/RecoveryOperationServiceTest.java`: concurrency, active-operation, and receipt regressions.
- `backend/src/test/java/org/osi/server/recovery/RecoveryOperationControllerTest.java`: non-owner admin and demoted-owner endpoint regressions.
- `backend/src/test/java/org/osi/server/recovery/RecoveryBundleServiceTest.java`: disabled/demoted membership regressions.
- `backend/src/main/resources/application.yml`: multipart file/request limits aligned with the 256 MiB bundle limit.
- `backend/src/test/java/org/osi/server/recovery/RecoveryMultipartConfigurationTest.java`: effective multipart-limit regression.

## Task 1: Stop delivery of expired physical effects

- [x] Inject a `Clock` into `CommandService`. Add repository and service cases with one command whose `expires_at` equals the captured `now`, one elapsed command, and one future `PENDING` physical command. The boundary is `expires_at <= now`; expiry and selection must receive the same captured `Instant`, and only the future row may be returned.
- [x] Run `cd backend && ./gradlew test --tests org.osi.server.command.DeviceCommandRepositoryDbTest`; confirm the new test fails because both rows are returned.
- [x] Add a modifying query that sets `PENDING`/`SENT` rows with `expires_at <= capturedNow` to `EXPIRED`, clears lease fields, and records `effect_expired`. Call it inside `CommandService.getPendingCommandsForGateway` before selecting legacy commands.
- [x] Change `CommandService.getPendingCommandsForGateway` from a read-only transaction to a write transaction. Add a Spring/PostgreSQL integration test that invokes the actual service method and proves expiry and selection occur in one transaction; the reflected SQL and Mockito tests remain narrow guards.
- [x] Add a service test asserting that expiry runs before selection and an elapsed command is absent from the returned list.
- [x] Run the two command test classes and confirm they pass.
- [x] Add edge ledger cases for elapsed, malformed, and exactly-now `expires_at`. The ledger operation must validate expiry before normal dispatch, atomically write the `applied_commands` terminal `EXPIRED` row and `command_ack_outbox` row, and return no effect output. Crash/replay must reproduce the same stored ACK rather than dispatching the effect or publishing an unqueued side-channel ACK.
- [x] Wire the ledger result into the existing ACK drain path before all downstream command nodes. Pin this order in the flow guard.
- [x] Run `node scripts/verify-command-safety.js` and the new edge harness.

## Task 2: Bind edge authorization to the immutable token subject

- [x] Extend `/api/me` tests with two rows: token `{userId: 7, username: "old-name"}`, current row 7 renamed, and row 8 reusing `old-name`. Expect 403 rather than row 8's scope.
- [x] Extend the scoped-history harness with the same rename/reuse setup and expect the request to fail before zone or gateway data is queried.
- [x] Add the same rename/reuse regression to zone environment, dendrometer recommendation, device history, today-liters, and sensor-export reads. Cover the username-only lookups generated by `migrate-flows-scoped-access-phase-b-zone-reads.js` and `migrate-flows-scoped-access-phase-b-device-reads.js`.
- [x] Run `node scripts/test-device-api-auth-status.js`, `node scripts/test-scoped-access-history.js`, and `node scripts/test-scoped-access-shared-reads.js`; confirm they fail because the current flow resolves by username alone.
- [x] In a one-shot flow editor, preserve both `auth.userId` and `auth.username`. Change every scoped current-user query to `WHERE id = ? AND username = ?`, including `/api/me`, history, zone environment, dendrometer recommendations, device histories, today-liters, and sensor export.
- [x] Update the source migration scripts and static guards that pin those function bodies. Do not hand-edit either `flows.json`.
- [x] Re-run `node scripts/test-device-api-auth-status.js`, `node scripts/test-scoped-access-history.js`, and `node scripts/test-scoped-access-shared-reads.js`.

## Task 3: Repair durable-history identity transitions and schema verification

- [x] Add a worker test with stored dirty key `VALVE_ACTUATION|OLD_EUI|exp-1`, submitted key `VALVE_ACTUATION|NEW_EUI|exp-1`, and an APPLIED server result for the submitted key. Expect the stored dirty key to become `done`. Add a second case where two old EUI keys normalize to one submitted key and expect both stored rows to complete.
- [x] Run `node scripts/test-sync-history-worker.js`; confirm the new test fails because ACK matching compares the server key directly with `row_key`.
- [x] Change dirty batch metadata to retain a multimap from each `submittedHistoryKey` to one or more `dirtyRowKey` values. Complete every represented durable row only after that submitted key is accepted. Never rewrite the durable primary key merely because the installation EUI changed.
- [x] Use a one-shot flow editor for the canonical flow, then mirror it byte-for-byte to bcm2709.
- [x] Register the four `0040__durable_history_batch.sql` triggers in `MIGRATION_OWNED_TRIGGERS` with their owning migration.
- [x] Run `node scripts/test-sync-history-worker.js` and `node scripts/verify-runtime-schema-parity.js`; expect both to exit 0.

## Task 4: Apply journal owner-plus-grant scope in the cloud

- [x] Add PostgreSQL/Flyway query-service tests proving: an owner sees owned resources; a grantee sees granted plots, their entries, and containing groups; a researcher cannot see a foreign ungranted plot; an admin follows the edge's admin visibility rule. Exercise the real mirror schema and PostgreSQL-specific aggregate SQL; mocks and H2 are insufficient for these set-semantics cases.
- [x] Add controller tests proving exports use the same visible entry set and a mutation against an ungranted existing plot/resource returns 404 before a desired-state command is created.
- [x] Add mutation tests proving granted updates preserve the canonical `owner_user_uuid`, original entry `author_principal_uuid`, and original `author_label`, while audit/desired-operation attribution records the acting cloud user separately.
- [x] Add tests rejecting an entry moved to a foreign plot and a plot group containing any foreign or ungranted plot UUID.
- [x] Run the journal tests and confirm owner-only queries and mutation behavior fail them.
- [x] Change `JournalQueryService` to accept `GatewayScope`. Match the edge rules in `osi-journal/api.js`: entries are owner rows plus rows attached to visible plots; plots are owned plus granted; plot groups are owned plus groups containing a visible plot; custom vocabulary stays owner-scoped.
- [x] Add `JournalAccessService` methods that resolve an existing mirror resource, determine every referenced plot, and call `scope.requirePlot` for each. Existing updates and voids retain canonical ownership and original author fields; new resources retain creator ownership. Any supplied entry plot or plot-group membership must be fully visible before enqueue.
- [x] Pass the resolved scope through `JournalController` reads, exports, upserts, and void operations. Return 404 for foreign identifiers.
- [x] Run all journal and scoped-access tests.

## Task 5: Make scope lookup failures fail closed in the edge GUI

- [x] Add `ScopeContext` cases for a rejected fetch, a never-resolving fetch, and a bare context consumer with no provider. Expect `canWrite=false`, `isAdmin=false`, and both visibility predicates false until an explicit successful flag-off response is received.
- [x] Add a rejection, visible-error, retry, and successful-resolution transition test for `ScopeStatusBanner`: retry must be able to resolve to either an explicit flag-off profile or a scoped profile without exposing wildcard authority in between.
- [x] Run the single Vitest file and confirm it fails with writable admin defaults.
- [x] Make the context default and loading state fail closed. Represent lookup failure separately from a successful flag-off response. Preserve wildcard admin behavior only when the server explicitly returns `features.scoped_access=false`; `profile === null` can never imply wildcard access.
- [x] Expose an error plus `retry` through the context without inventing an unscoped profile. Mount `ScopeStatusBanner` from `App.tsx`; it must explain that permissions could not be loaded and invoke the context retry while route and action guards continue consuming fail-closed booleans.
- [x] Run `npm run typecheck`, the ScopeContext test, and `npm run test:unit`.

## Task 6: Keep terminal desired state separate from canonical state

- [x] Extend the device and journal API normalization tests across `pending`, `acknowledged`, `conflicted`, `rejected`, `expired`, `applied`, and `superseded`. Only `pending` and `acknowledged` may overlay the effective display object.
- [x] Assert that every terminal operation preserves the canonical device or journal resource as the effective state while retaining the terminal desired payload and status separately for reconciliation messaging.
- [x] Run the two targeted frontend test files and confirm the current conflicted/terminal overlays fail.
- [x] Centralize the overlay predicate in `frontend/src/services/api.ts` and use it for both device and journal normalization. Do not discard terminal desired-state metadata.
- [x] Update affected cards/notices so a terminal desired value is shown as a separate failed/conflicted/superseded proposal rather than rendered as canonical state.
- [x] Run the targeted tests, the frontend unit suite, and the frontend build.

## Task 7: Lock recovery authority and state transitions

- [x] Add service tests proving a disabled, viewer, or researcher membership cannot preview, start, interrupt, roll back, upload, or list recovery bundles; an enabled gateway admin can.
- [x] Add HTTP tests for preview, start, interrupt, roll back, and audit using an enabled non-owner gateway admin and a demoted original installation owner. Remove or replace `RecoveryOperationController.requirePathInstallation -> requireOwnedOperation`; controller prechecks must use the same fresh gateway-admin scope as the services.
- [x] Add tests where two PREVIEWED operations target one installation. After the first starts, the second start must fail; prepare and complete must fail when `currentRecoveryOperationUuid` names another operation. Use an enabled non-owner gateway admin for success and a demoted original installation owner for denial.
- [x] Add a PostgreSQL concurrency integration test with two transactions synchronized at a barrier. Exactly one start may install its operation UUID; the other must fail after the lock releases. Add a second lock-order test that exercises concurrent start and transition without deadlock.
- [x] Run the recovery tests and confirm the owner-only and unlocked implementations fail.
- [x] Add pessimistic-write repository methods for both installation and operation rows. Use one lock order everywhere: installation first, operation second. Start requires a null current operation and atomically installs its UUID; every later transition requires exact UUID equality before mutation.
- [x] Replace owner-only human authorization with fresh `GatewayScopeService` admin authorization for the installation's current EUI. Split human-authorized bundle selection/listing from internal operation-token decryption so gateway download does not impersonate or depend on the installation owner.
- [x] Run the recovery service and controller tests.

## Task 8: Bind recovery receipts and align upload limits

- [x] Add Flyway columns for the durable prepare-receipt SHA, reconciliation-receipt SHA, and receipt-proof key identifier. Update the entity and migration integration test.
- [x] Replace arbitrary-hash fixtures with canonical receipt detail containing operation UUID, installation UUID, gateway EUI, kind, protocol state, prepare-receipt SHA, restore audit SHA, and completion timestamp, plus a MAC created with a receipt key that is not the sync-token or operation-token secret.
- [x] Add tests rejecting a self-consistent SHA without a valid MAC, a detail map whose identifiers differ from the request, a completion whose prepare-receipt SHA differs from the locked operation, and replay after completion.
- [x] Run the recovery tests and confirm the current shape-only checks fail.
- [x] Add `RecoveryReceiptVerifier` and a property-gated local/test HMAC implementation using `osi.recovery.local-receipt-verification-key-base64`. Verify the MAC in constant time, bind the locked operation's stored prepare receipt, and accept the proof once. Keep production recovery disabled until an approved receipt-key provider exists.
- [x] Configure `spring.servlet.multipart.max-file-size` as `${OSI_RECOVERY_MAX_FILE_SIZE:256MB}` and `max-request-size` as `${OSI_RECOVERY_MAX_REQUEST_SIZE:257MB}`. Keep `osi.recovery.max-bundle-bytes` at 268435456 bytes and reject `MultipartFile.getSize()` above the service cap before opening the stream.
- [x] Replace `MultipartFile.getBytes()` with a bounded input stream. Hash and validate length while streaming plaintext to an owner-only temporary file, then stream AES-GCM output to a second temporary file. Persist ciphertext without retaining plaintext and ciphertext byte arrays simultaneously; zero key material and delete both files in `finally`.
- [x] Add a context test for effective limits plus MockMvc cap and cap-plus-one cases using a size-reporting multipart stub/stream so the rejection case does not allocate 256 MiB.
- [x] Run the recovery test package.

## Task 9: Cross-repo verification and publication

- [x] Run server gates: `cd backend && ./gradlew test`, `./gradlew build`; then `cd ../frontend && npm run test:unit && npm run build`.
- [x] Run edge flow gates: roundtrip guard, `verify-no-new-silent-catch.js`, `test-flows-wiring.js`, `verify-flows-size-ratchet.js`, `flows-bare-require-scan.js`, `verify-flows-fn-parse.js`, `verify-no-stray-ddl.js`, and `verify-sync-flow.js`.
- [x] Run edge schema gates: `verify-migrations.js`, `verify-seed-replay.js`, `verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js`, `verify-boot-ddl-interpolation.js`, `verify-trigger-body-parity.js`, and `verify-profile-parity.js`.
- [x] Run edge GUI gates from `web/react-gui`: `npm run typecheck`, `npm run test:unit`, and `npm run build`.
- [x] Run `git diff --check` and `git status --short --branch` in both worktrees.
- [x] Update the AgroLink execution report with the exact commands, exit codes, and remaining deferred production recovery-key boundary.
- [x] Run `node .claude/skills/anti-slop-writing/slop-check.js` on this plan and the execution report.
- [x] Commit edge and server changes separately with scoped prefixes, push both existing branches, and verify each remote branch resolves to the local head.
