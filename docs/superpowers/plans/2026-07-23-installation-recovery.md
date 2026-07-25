# Installation-bound recovery implementation plan

**Goal:** Add a stable installation identity, offline verifier v2, encrypted
recovery-bundle storage, and a guarded restore state machine without selecting
an external key provider or bypassing the existing OSI OS restore protocol.

**Repositories:** `osi-os` edge and `osi-server` cloud
**Execution:** Test first, one mutation or gate at a time, paired commits pushed
before the next slice

## Slice 1: Edge installation identity and verifier v2

**Edge files**

- Add ordered migration `0041__installation_identity.sql`.
- Update `database/seed-blank.sql`, checksum manifest, and seven bundled DBs.
- Add `osi-installation-helper` to both maintained profiles.
- Add a script-only flow migration for account link, login, bootstrap, and
  recovery-state reporting.
- Extend focused schema, helper, auth, flow, and profile tests.

**Behavior**

1. Add and seed the singleton `installation_identity` row.
2. Add `sync_link_state.installation_uuid` and keep it equal to the singleton.
3. Record current and previous gateway EUIs without changing operational
   aggregate keys.
4. Send `installationUuid` and `installation_recovery_v1` during link and
   bootstrap.
5. Store and verify server offline verifier version 2 against installation
   UUID. Preserve v1 verification for existing rows.
6. Reject a server link response whose installation UUID differs from the
   local row.
7. Surface recovery state in `/api/sync/state`.

**Gates**

- fresh seed and ordered migration replay;
- UUID singleton and EUI replacement tests;
- v1/v2 verifier input tests;
- auth credential isolation;
- flow compile, no-new-silent-catch, helper registration, profile parity, and
  umbrella sync verification.

## Slice 2: Server installation registry and link upgrade

**Server files**

- Add `V2026_07_25_002__installation_recovery.sql`.
- Add `GatewayInstallation`, repository, and service.
- Extend `LinkedGatewayAccount` with nullable installation UUID and recovery
  capability.
- Extend local-sync and bootstrap DTOs and services.
- Extend gateway migration to resolve previous EUI lineage from the
  installation registry.

**Behavior**

1. Observe a syntactically valid installation UUID with its current gateway
   EUI.
2. Retain prior current EUIs in stable order and reject cross-installation EUI
   conflicts.
3. Issue verifier v2 only when the request includes the capability and a valid
   installation UUID; otherwise issue v1.
4. Echo the installation UUID in the local-sync response.
5. Bind linked accounts to installation UUID without breaking existing
   gateway-scoped uniqueness and authorization.

**Gates**

- red-first service and controller tests;
- v1/v2 compatibility and EUI replacement integration tests;
- Flyway migration on PostgreSQL;
- focused sync, membership, and architecture tests;
- complete backend test and build.

## Slice 3: Envelope encryption and durable local/test storage

**Server files**

- Add `RecoveryKeyProvider`.
- Add a property-gated local AES-GCM provider for tests and development.
- Add bundle envelope, repository, service, and controller.
- Use the Task 10 migration tables for ciphertext and audit state.

**Behavior**

1. Validate metadata and membership before reading bundle bytes.
2. Generate a per-bundle data key and encrypt with AES-256-GCM.
3. Wrap the data key through the provider abstraction.
4. Persist ciphertext and wrapped-key material only.
5. Decrypt only for preview or an authorized restore operation.
6. Fail closed when no provider is configured.

**Gates**

- round trip, wrong key, truncation, nonce and metadata tamper tests;
- repository integration proving no plaintext persistence;
- authorization and maximum-size tests;
- architecture, full backend test, and build.

## Slice 4: Preview, audit, interruption, and rollback

**Edge files**

- Add an installation-recovery adapter beside the existing restore tooling.
- Add temp-database tests; do not touch a live Pi.

**Server files**

- Add recovery-operation state transitions and audit queries.
- Add preview, start, edge-download, progress, complete, and rollback-local
  endpoints behind the configured local provider.

**Behavior**

1. Preview verifies target UUID, age, hash, SQLite integrity, schema head, and
   witness metadata without mutating the target.
2. Start requires the exact preview and creates a rollback reference.
3. Edge preparation emits inputs for `prepare-database-restore`; it never
   replaces the live database directly.
4. Interrupted restore remains `RESTORING` or `RECONCILING` after restart.
5. Completion requires the existing reconciliation receipt before changing
   the installation to `ACTIVE`.
6. Rollback uses the same guarded boundary and records an audit event.

**Gates**

- EUI replacement, reinstall, partial bundle, wrong installation, wrong key,
  stale bundle, interruption, reconciliation, and rollback scenarios;
- existing restore-protocol tests;
- edge migration, sync, and profile gates;
- server focused, full, build, and PostgreSQL migration gates.

## Slice 5: Control documents and final Task 10 evidence

1. Update the parity matrix from `cloud-missing` to the measured local/test
   status.
2. Record provider selection and production restore as deferred, not failed.
3. Record exact edge and server SHAs and remote verification.
4. Run the anti-slop checker and `git diff --check`.

## Stop conditions

- Do not configure a production provider or invent credentials.
- Do not upload a real database or access production.
- Do not run a live restore.
- Do not bypass the existing stopped-writer, activity-witness, receipt,
  reconciliation, or rollback boundary.
- Do not move operational aggregates from gateway EUI to installation UUID.
- Do not include network-drive or external imported-reading behavior.
