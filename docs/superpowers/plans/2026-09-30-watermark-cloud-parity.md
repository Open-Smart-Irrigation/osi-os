# WATERMARK Cloud Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror edge-owned WATERMARK calibration into OSI Server, make calibration, Chameleon configuration, and generic soil-depth edits pending-first cloud commands, restore contact state for FPort 11 without syncing diagnostics, and expose confirmed versus pending state safely in the cloud GUI.

**Architecture:** The edge remains authoritative. `WATERMARK_CALIBRATION` is a device-keyed sync resource with retained tombstones; the existing `DEVICE` aggregate remains authoritative for `chameleon_enabled` and soil-depth fields. OSI Server accepts and mirrors edge state, records desired state, and issues exact-base pending commands only when the gateway advertises the operation-specific capability. Edge command application uses one trusted binding, one authorization rule, and the existing local writers. FPort 11 sends a contact-only MQTT envelope; canonical values continue through `DEVICE_DATA_APPENDED`, and raw WATERMARK diagnostics never leave the edge.

**Tech Stack:** Node-RED function nodes and Node 22 helper modules; SQLite ordered migrations and `node:sqlite` tests; JSON Schema draft-07 contracts; Spring Boot 3, Java 17, JPA/JdbcTemplate, Flyway/PostgreSQL, JUnit 5, Mockito and AssertJ; React, TypeScript, Vitest and react-i18next.

**Spec:** `docs/superpowers/specs/2026-09-30-watermark-cloud-parity-design.md`

## Global Constraints

- Work only in `<osi-os>/.worktrees/watermark-cloud-parity` and `<osi-server>/.worktrees/watermark-cloud-parity`. Do not deploy, access production, or connect to a gateway.
- Rebase both feature branches onto their current `origin/main` before implementation. At planning time, edge `origin/main` is `1939a04a6d9c`; cloud `origin/main` is `2cbe5e2e6cbd`. Re-run all base-sensitive verifiers after any rebase.
- The canonical contract lives in `osi-os/docs/contracts/sync-schema/`. Stage cloud acceptance first, but do not let the cloud copy become an independent contract.
- Cloud must be deployed before an edge build advertises any new capability or emits a WATERMARK calibration event.
- The edge migration is exactly `database/migrations/ordered/0068__watermark_cloud_parity.sql`. Do not edit the frozen `sync-init-fn` DDL.
- The server migration is exactly `backend/src/main/resources/db/migration/V2026_09_30_001__watermark_cloud_parity.sql`. Immediately before merge, list `origin/main` migrations and rename this file if necessary so it sorts strictly after the then-current Flyway head; run `sh scripts/verify-flyway-ordering.sh` after the rename.
- Use only synthetic fixture EUIs from the documented ranges: gateway `0016C001F1000001`, device `A840410000000001`, and foreign device `A840410000000002`. Do not put customer names, real EUIs, tailnet addresses, production hosts, or workstation attachment paths in code, fixtures, or docs.
- Do not sync `watermark_readings`, raw payloads, ADC codes, flags, resistance, offset, supply, die temperature, per-reading calibration version, or conversion version.
- Keep the scheduler interlock unchanged. This work must not admit WATERMARK samples to irrigation.
- Preserve FPort 2 LSN50 ingest, assigned-device behavior, and all existing command paths.
- Modify each `flows.json` only with a one-shot Node parse/mutate/stringify script after proving a no-op round-trip is byte-identical. Write the bcm2712 source and bcm2709 mirror byte-for-byte.
- Every task starts with a focused failing test and ends with its focused green command. Do not combine tasks to avoid a red test.
- Commit in the order in “Paired landing and rollout” below. Do not amend commits.

## Review Focus

1. A same-type desired-state edit with a changed base or effect key must issue a new command; it must not rewrite an old command while retaining its old binding.
2. Protected commands validate trusted context and semantic binding before replay lookup. After that gate, exact command-ID replay precedes effect-key replay; neither lookup may return a stored result unless the trusted binding hash matches, and a reused effect key with different normalized intent is a conflict.
3. `irrigation_zone_id IS NULL` is the only unassigned state. A dangling, deleted, or foreign non-null assignment never receives the unassigned owner/admin exception.
4. Bootstrap must reload retained state before `observeMirror`. A stale snapshot cannot report itself as convergence, a tombstone cannot reset the base to zero, and bootstrap cannot manufacture a missing ACK.
5. Contact time and measurement time remain separate: FPort 11 contact changes `lastSeen`; accepted canonical snapshot data changes `currentStateRecordedAt`. Neither timestamp moves backwards.
6. The GUI must show pending values separately from confirmed values and remove edit controls when the exact capability is absent or still loading.
7. History remains labelled “Soil tension 1” and “Soil tension 2” regardless of current calibration or Chameleon state.
8. Planned edge downgrade is forbidden until the durable protected-command fence reports no PENDING, SENT, or LEASED protected work. Delayed capability refresh and late terminal responses must not reopen delivery or clear the fence early.

---

### Task 1: Harden desired-state command rewriting

**Repository:** `osi-server`

**Files:**
- Modify: `backend/src/main/java/org/osi/server/desiredstate/DesiredStateService.java`
- Modify: `backend/src/test/java/org/osi/server/desiredstate/DesiredStateServiceTest.java`

**Interfaces:** `DesiredStateService.request`, private `canRewrite`, `DesiredStateService.Request`, `DeviceCommand.effectKey`, `DesiredStateOperation.baseSyncVersion`.

- [ ] Add two tests beside `secondConfigEditReusesSafeUnleasedCommandAndSupersedesFirstOperation`: one changes only `baseSyncVersion`; the other keeps the base but changes `effectKey`. Assert each call creates a second `DeviceCommand`, supersedes the prior operation, and does not call `rewriteUnleasedGatewayCommand`.
- [ ] Keep the existing same-base, same-effect-key test and assert it still rewrites one unleased command.
- [ ] Run RED:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity/backend
./gradlew test --tests org.osi.server.desiredstate.DesiredStateServiceTest
```

Expected: both new tests fail because current `canRewrite` checks only mutation kind, command type, command status, and lease state.

- [ ] Change `canRewrite` to require all of:

```java
operation.getBaseSyncVersion() == request.baseSyncVersion()
        && operation.getCommand() != null
        && request.effectKey().equals(operation.getCommand().getEffectKey())
```

Keep the existing CONFIG, same-command-type, pending/sent, and unleased checks.

- [ ] Run GREEN with the same Gradle command. Expected: all `DesiredStateServiceTest` tests pass.
- [ ] Commit in `osi-server`: `fix(sync): bind desired-state rewrites to base and effect key`.

---

### Task 2: Define and stage the cross-repository contract

**Repositories:** `osi-os`, then `osi-server`

**Edge files:**
- Modify: `docs/contracts/sync-schema/resources.schema.json`
- Modify: `docs/contracts/sync-schema/events.schema.json`
- Modify: `docs/contracts/sync-schema/commands.schema.json`
- Modify: `docs/contracts/sync-schema/effect-keys.md`
- Modify: `docs/contracts/sync-schema/canonicalization.md`
- Modify: `docs/contracts/sync-schema/README.md`
- Create: `docs/contracts/sync-schema/watermark-cloud-parity-v1.json`
- Modify: `scripts/test-contract-schemas.js`
- Modify: `scripts/verify-sync-contract.js`
- Modify: `scripts/verify-sync-op-parity.js`
- Modify: `scripts/fixtures/sync-contract-staging.json`

**Cloud files:**
- Modify: `backend/src/test/resources/sync-contract/resources.schema.json`
- Modify: `backend/src/test/resources/sync-contract/events.schema.json`
- Modify: `backend/src/test/resources/sync-contract/commands.schema.json`
- Modify: `backend/src/test/resources/sync-contract/effect-keys.md`
- Modify: `backend/src/test/resources/sync-contract/canonicalization.md`
- Create: `backend/src/test/resources/sync-contract/watermark-cloud-parity-v1.json`
- Modify: `backend/src/test/resources/sync-contract/sync-contract-golden.json`
- Modify: `backend/src/test/java/org/osi/server/sync/SyncContractVendorTest.java`
- Modify: `scripts/verify-edge-sync-contract-vendor.sh`

**Contract:** Add events `WATERMARK_CALIBRATION_UPSERTED` and `WATERMARK_CALIBRATION_DELETED`; commands `SET_WATERMARK_CALIBRATION`, `DELETE_WATERMARK_CALIBRATION`, existing `UPSERT_DEVICE_SOIL_DEPTHS`, and existing `SET_CHAMELEON_CONFIG`; resource `WATERMARK_CALIBRATION`, keyed by uppercase `device_eui`. Pin these exact keys:

```text
watermark_calibration:set:{gateway_eui}:{device_eui}:{base_sync_version}
watermark_calibration:delete:{gateway_eui}:{device_eui}:{base_sync_version}
device_soil_depths:set:{gateway_eui}:{device_eui}:{base_sync_version}
chameleon_config:set:{gateway_eui}:{device_eui}:{base_sync_version}
```

- [ ] Add contract tests first. Use synthetic fixture EUIs `0016C001F1000001`, `A840410000000001`, and `A840410000000002` for gateway, device, and foreign-device roles. Cover uppercase EUI enforcement, required gateway/device/base/actor fields, set versus delete shape, metadata omission versus explicit null, numeric canonicalization, malformed effect keys, wrong gateway/device/base in a key, and same key with different intent.
- [ ] Extend the closed sets in `scripts/verify-sync-op-parity.js` and their byte-checked representation in `scripts/fixtures/sync-contract-staging.json`. During this contract-only task, put `SET_WATERMARK_CALIBRATION` and `DELETE_WATERMARK_CALIBRATION` in both exact command deferred sets. Also put existing `SET_CHAMELEON_CONFIG` and `UPSERT_DEVICE_SOIL_DEPTHS` in the exact cloud-deferred command set until their pending-first issuers land. Put `WATERMARK_CALIBRATION_UPSERTED` and `WATERMARK_CALIBRATION_DELETED` in both `EXACT_EDGE_DEFERRED_OPS` and `EXACT_CLOUD_DEFERRED_EVENT_OPS`. Do not classify an op as deployed merely because its schema exists.
- [ ] Pin the cleanup owner in tests: Task 4 removes only the two cloud-deferred event entries when the applier lands; Task 5 removes only the two cloud-deferred calibration commands when issuance lands; Task 6 removes only the Chameleon/depth cloud-deferred commands when their pending-first issuers land; Task 7 removes only the two edge-deferred events when 0068 triggers land; Task 9 removes only the two edge-deferred calibration commands when the protected router lands. A task that removes an entry without its named runtime implementation must fail parity.
- [ ] Keep the cloud event-op enum unchanged in this task. Vendor the resource, effect-key and canonicalization contract, plus command acceptance, but stage the two inbound event ops until Task 4 installs their real applier. `SyncOpCoverageTest` must remain green throughout; never exclude WATERMARK from that test or broaden its accepted-without-handler set.
- [ ] Run RED in edge:

```bash
cd <osi-os>/.worktrees/watermark-cloud-parity
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
node scripts/verify-sync-op-parity.js
```

Expected: new vectors fail because calibration resource/events, staging entries, and exact semantic effect-key bindings are absent; existing Chameleon/depth schemas are not yet exact-base bound.

- [ ] Add `WatermarkCalibration` and normalized mutation definitions. Require `gateway_device_eui`, `device_eui`, `actor_user_uuid`, `base_sync_version`, operation, and normalized intent on commands. Preserve metadata semantics: omitted means keep; explicit null means clear.
- [ ] State that the trusted binding hash covers command type, resource, device, gateway, local actor UUID, base version, operation, and normalized intent. State that command-ID replay precedes effect-key replay and mismatched binding/intent conflicts.
- [ ] Vendor the canonical resource, effect-key, canonicalization, command, and vector files to cloud test resources. Keep the two WATERMARK event ops out of the cloud `events.schema.json`, `eventOperations.accepted`, and `eventOperations.serverHandlerEnabled` until Task 4. Do not weaken `SyncOpCoverageTest` or `verify-edge-sync-contract-vendor.sh` to make drift pass.
- [ ] Run cloud RED before implementation acceptance:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity/backend
./gradlew test --tests org.osi.server.sync.SyncContractVendorTest
```

Expected before the cloud fixture/schema changes: missing command/resource definitions. Expected after vendor changes: pass while inbound WATERMARK event ops remain staged rather than accepted.

- [ ] Run GREEN: the three edge commands above, the two cloud tests above, and:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity
EDGE_CONTRACT_ROOT=<osi-os>/.worktrees/watermark-cloud-parity sh scripts/verify-edge-sync-contract-vendor.sh
```

Expected: all pass; every file covered by the vendor parity script compares byte-for-byte, while command/event staging remains explicit in each runtime's schema and golden fixture.
- [ ] Commit edge first: `docs(sync): define WATERMARK cloud parity contract`.
- [ ] Commit cloud second: `test(sync): stage WATERMARK cloud parity contract`.

---

### Task 3: Add cloud schema, mirror domain, and capability persistence

**Repository:** `osi-server`

**Files:**
- Create: `backend/src/main/resources/db/migration/V2026_09_30_001__watermark_cloud_parity.sql`
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkCalibrationMirror.java`
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkCalibrationRepository.java`
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkCalibrationValues.java`
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkCalibrationView.java`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccount.java`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccountService.java`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewaySyncService.java`
- Modify: `backend/src/test/java/org/osi/server/user/LinkedGatewayAccountServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/user/LinkedGatewaySyncServiceTest.java`
- Create: `backend/src/test/java/org/osi/server/watermark/WatermarkCloudParityMigrationIT.java`

- [ ] Write migration and capability tests first. Assert the mirror retains `deleted_at` and `sync_version`, has a unique uppercase `device_eui`, binds `gateway_eui`, stores all eight coefficients and four metadata fields, and adds four non-null default-false columns to `linked_gateway_accounts`:

```text
watermark_supported
chameleon_config_commands_supported
device_soil_depth_commands_supported
protected_command_delivery_fenced
```

- [ ] Run RED:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity/backend
./gradlew test --tests org.osi.server.watermark.WatermarkCloudParityMigrationIT --tests org.osi.server.user.LinkedGatewayAccountServiceTest --tests org.osi.server.user.LinkedGatewaySyncServiceTest
```

Expected: schema objects and summary fields are absent.

- [ ] Implement `WatermarkCalibrationMirror` with device EUI as its stable key; include gateway EUI, coefficients, metadata, `syncVersion`, `updatedAt`, `deletedAt`, and a cloud application timestamp. Do not add raw-reading columns.
- [ ] Implement `WatermarkCalibrationValues` as the one normalizer used by event comparison, desired JSON, and binding hashes. Normalize integral numbers without `1`/`1.0` drift, validate phase-1 ranges, canonicalize instants, and distinguish absent metadata from explicit null.
- [ ] Add constants in `LinkedGatewayAccountService` for `watermark_v1`, `chameleon_config_commands_v1`, and `device_soil_depth_commands_v1`; set all three booleans in `applyEdgeCapabilities`, including clearing them on downgrade.
- [ ] Add `watermarkSupported`, `chameleonConfigCommandsSupported`, `deviceSoilDepthCommandsSupported`, and `protectedCommandDeliveryFenced` to `LinkedGatewaySyncService.LinkedGatewaySummary` and `summary`. Capability refresh must not clear the fence yet; Task 6 owns its reconciliation rule.
- [ ] Run GREEN with the RED command, then:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity
sh scripts/verify-flyway-ordering.sh
```

Expected: tests and ordering pass.
- [ ] Commit: `feat(watermark): add cloud mirror and capability schema`.

---

### Task 4: Activate cloud calibration events and bootstrap with retained-state convergence

**Repositories:** `osi-server`, with the paired cloud-deferred staging cleanup in `osi-os`

**Files:**
- Create: `backend/src/main/java/org/osi/server/sync/WatermarkCalibrationApplier.java`
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- Modify: `backend/src/main/java/org/osi/server/sync/SyncEventTxExecutor.java`
- Modify: `backend/src/main/java/org/osi/server/security/EdgeOwnershipService.java`
- Modify: `backend/src/test/resources/sync-contract/events.schema.json`
- Modify: `backend/src/test/resources/sync-contract/sync-contract-golden.json`
- Create: `backend/src/test/java/org/osi/server/sync/WatermarkCalibrationApplierTest.java`
- Create: `backend/src/test/java/org/osi/server/sync/WatermarkCalibrationConvergenceTest.java`
- Modify: `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceBootstrapTest.java`
- Modify: `backend/src/test/java/org/osi/server/sync/EdgeBootstrapRequestDeserializationTest.java`
- Modify: `backend/src/test/java/org/osi/server/sync/SyncApplierRegistryTest.java`
- Modify in edge worktree: `scripts/verify-sync-op-parity.js`
- Modify in edge worktree: `scripts/fixtures/sync-contract-staging.json`

- [ ] Write RED tests for upsert, tombstone, idempotent equal-version replay, divergent equal-version rejection, stale input, foreign gateway rejection, missing-device retry, and retained mirror/resource-watermark maximum. Assert that normal event watermark persistence and `DesiredStateService.observeMirror` occur exactly once in `SyncEventTxExecutor`, not in `WatermarkCalibrationApplier`.
- [ ] Add bootstrap cases for: calibration before link; retained tombstone; stale snapshot behind a newer event; lost event closed by bootstrap; ACK missing after bootstrap stays acknowledged/pending; and device parent arriving in the same bootstrap before calibration.
- [ ] Add an ObjectMapper fixture test for an edge-shaped top-level property named `watermark_calibrations`. Pin `@JsonProperty("watermark_calibrations")` with `@JsonAlias("watermarkCalibrations")`, including a deleted row carrying its effective op. Serialization/deserialization must preserve the snake-case edge-to-cloud shape.
- [ ] Run RED:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity/backend
./gradlew test --tests org.osi.server.sync.WatermarkCalibrationApplierTest --tests org.osi.server.sync.WatermarkCalibrationConvergenceTest --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest --tests org.osi.server.sync.EdgeBootstrapRequestDeserializationTest --tests org.osi.server.sync.SyncApplierRegistryTest --tests org.osi.server.sync.SyncOpCoverageTest
```

Expected: no applier/dispatch/bootstrap field exists.

- [ ] Implement `WatermarkCalibrationApplier` for both event names. It resolves the parent `Device`, requires its current gateway binding to match the authenticated gateway, normalizes the row, and persists the mirror. It does not write `sync_resource_watermarks` and does not call `DesiredStateService.observeMirror`; `SyncEventTxExecutor` already owns both operations for ordinary events.
- [ ] Extend `SyncEventTxExecutor.isParentMissing` for the applier's exact “Device not found for WATERMARK calibration sync” exception. Do not put this rule in `SyncExceptionClassifier`.
- [ ] Add one retained-row bootstrap seam to `SyncEventTxExecutor` that applies the same resource/version/hash checks, invokes the applier, reloads the retained calibration row, updates the resource watermark if appropriate, and calls `observeMirror` with the retained effective op/payload/version. `EdgeSyncService` only supplies each bootstrap item to this seam; it must not reproduce watermark or convergence orchestration.
- [ ] Add `@JsonProperty("watermark_calibrations") @JsonAlias("watermarkCalibrations") List<Map<String, Object>> watermarkCalibrations` to `EdgeSyncService.EdgeBootstrapRequest`, default it to an empty immutable list in every compatibility constructor, and process it after `devices` through the retained-row seam.
- [ ] Never report incoming stale snapshot data to `observeMirror`. Reload the repository row after apply/ignore. Do not mark an operation APPLIED without its durable ACK.
- [ ] Now add the two WATERMARK event ops to the cloud `events.schema.json`, `eventOperations.accepted`, and `eventOperations.serverHandlerEnabled`. Remove them from edge `EXACT_CLOUD_DEFERRED_EVENT_OPS` and the matching `scripts/fixtures/sync-contract-staging.json` list in the paired staging-cleanup commit. Do not remove the edge-deferred entries until the 0068 triggers land in Task 7.
- [ ] Run GREEN with the RED command. Expected: all listed convergence cases pass.
- [ ] Commit cloud: `feat(watermark): mirror calibration events and bootstrap`.
- [ ] Commit edge staging cleanup: `test(sync): activate cloud WATERMARK event handling`.

---

### Task 5: Implement cloud authorization and pending-first calibration API

**Repositories:** `osi-server`, with the paired cloud-deferred staging cleanup in `osi-os`

**Files:**
- Create: `backend/src/main/java/org/osi/server/device/DeviceConfigurationCommandAuthorizer.java`
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkCalibrationCommandService.java`
- Create: `backend/src/main/java/org/osi/server/watermark/WatermarkCalibrationController.java`
- Create: `backend/src/test/java/org/osi/server/device/DeviceConfigurationCommandAuthorizerTest.java`
- Create: `backend/src/test/java/org/osi/server/watermark/WatermarkCalibrationCommandServiceTest.java`
- Create: `backend/src/test/java/org/osi/server/watermark/WatermarkCalibrationControllerTest.java`
- Modify in edge worktree: `scripts/verify-sync-op-parity.js`
- Modify in edge worktree: `scripts/fixtures/sync-contract-staging.json`

**API:** `GET`, `PUT`, and `DELETE /api/v1/devices/{deviceEui}/watermark/calibration`. PUT and DELETE return `202 Accepted` with confirmed calibration, retained base version, and desired-state status; they never update the mirror directly.

- [ ] Write authorization tests for enabled owner/admin success when an eligible LSN50 has `irrigation_zone_id IS NULL`; assigned owner with grant success; viewer, disabled account, foreign owner, missing local actor UUID, absent zone grant, gateway ADMIN without the zone grant, dangling assignment, deleted zone, foreign zone, wrong device type, and read-only/account-wide access denial.
- [ ] Write command tests that pin the exact set/delete effect keys, maximum of mirror/resource-watermark base, tombstone recreate base, metadata null/omission normalization, whole-number stability, changed-base race rejection, and pending-until-ACK-plus-mirror behavior.
- [ ] Run RED:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity/backend
./gradlew test --tests org.osi.server.device.DeviceConfigurationCommandAuthorizerTest --tests org.osi.server.watermark.WatermarkCalibrationCommandServiceTest --tests org.osi.server.watermark.WatermarkCalibrationControllerTest
```

Expected: classes/endpoints do not exist.

- [ ] Implement `DeviceConfigurationCommandAuthorizer.authorize(User, Device, Capability)` as the shared cloud issuance rule. Require enabled account, mutation-capable `GatewayScope`, canonical local actor UUID, exact capability, current gateway binding, and narrow device type/scope. Assigned devices require current owner/grant checks. Only `device.getIrrigationZone() == null` may use the owner/admin unassigned exception.
- [ ] Build `DesiredStateService.Request` with resource type `WATERMARK_CALIBRATION`, resource ID device EUI, exact base, exact effect key, normalized desired payload, and command payload containing `gateway_device_eui`, `device_eui`, `actor_user_uuid`, `base_sync_version`, operation, and values.
- [ ] GET returns retained `syncVersion` and `deleted` even for a tombstone. PUT/DELETE fail closed when `watermarkSupported` is false.
- [ ] Remove `SET_WATERMARK_CALIBRATION` and `DELETE_WATERMARK_CALIBRATION` from the exact cloud-deferred command set and its staging fixture in the paired edge commit. Keep both edge-deferred until the real edge router lands in Task 9.
- [ ] Run GREEN with the RED command. Expected: all positive and negative cases pass.
- [ ] Commit cloud: `feat(watermark): queue authorized calibration commands`.
- [ ] Commit edge staging cleanup: `test(sync): activate cloud WATERMARK command issuance`.

---

### Task 6: Convert Chameleon and soil-depth cloud edits to exact-base desired state

**Repositories:** `osi-server`, with the paired cloud-deferred staging cleanup in `osi-os`

**Files:**
- Create: `backend/src/main/java/org/osi/server/device/DeviceConfigurationCommandService.java`
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java`
- Modify: `backend/src/main/java/org/osi/server/device/DeviceService.java`
- Create: `backend/src/main/java/org/osi/server/command/GatewayCommandCapabilityPolicy.java`
- Create: `backend/src/main/java/org/osi/server/command/GatewayCommandDeliveryFenceService.java`
- Create: `backend/src/main/java/org/osi/server/command/GatewayCommandDeliveryFenceController.java`
- Modify: `backend/src/main/java/org/osi/server/command/CommandLeaseService.java`
- Modify: `backend/src/main/java/org/osi/server/command/CommandService.java`
- Modify: `backend/src/main/java/org/osi/server/command/DeviceCommandRepository.java`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccountService.java`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccountRepository.java`
- Create: `backend/src/test/java/org/osi/server/device/DeviceConfigurationCommandServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/device/DeviceControllerTest.java`
- Modify: `backend/src/test/java/org/osi/server/device/DeviceServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/command/CommandLeaseServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/command/CommandLeaseServiceIT.java`
- Modify: `backend/src/test/java/org/osi/server/command/CommandLeaseServicePostgresTest.java`
- Modify: `backend/src/test/java/org/osi/server/command/CommandServiceTest.java`
- Create: `backend/src/test/java/org/osi/server/command/GatewayCommandDeliveryFenceServiceTest.java`
- Create: `backend/src/test/java/org/osi/server/command/GatewayCommandDeliveryFenceControllerTest.java`
- Modify: `backend/src/test/java/org/osi/server/user/LinkedGatewayAccountServiceTest.java`
- Modify in edge worktree: `scripts/verify-sync-op-parity.js`
- Modify in edge worktree: `scripts/fixtures/sync-contract-staging.json`

- [ ] Write RED tests showing `PUT /api/v1/devices/{deviceEui}/chameleon` and `PUT /api/v1/devices/{deviceEui}/soil-moisture-depths` return 202 and do not mutate `Device` before edge convergence. Pin command names `SET_CHAMELEON_CONFIG` and `UPSERT_DEVICE_SOIL_DEPTHS` and their exact effect keys.
- [ ] Repeat every negative authorization case from Task 5 for both operations, including wrong capability and dangling assignment.
- [ ] Add delivery RED tests for all three protected families: calibration set/delete require `watermarkSupported`, Chameleon requires `chameleonConfigCommandsSupported`, and depths require `deviceSoilDepthCommandsSupported`. Cover protocol-2 `CommandLeaseService.leasePending` and protocol-1 `CommandService.getPendingCommandsForGateway`; a missing or false capability must omit the command while unrelated commands still deliver.
- [ ] Add delivery-fence RED tests. `PUT /api/v1/admin/gateways/{gatewayEui}/protected-command-delivery-fence` requires SUPER_ADMIN, sets one gateway-wide fence across every linked-account row, blocks new protected issuance and both delivery protocols, and cancels only commands that have never been delivered (`PENDING`). `GET` returns the fence state and exact `pending`, `sent`, and `leased` counts; `safeToDowngrade` is true only when all three are zero. Treat protocol-1 `SENT` and protocol-2 `LEASED` as executable work: expiry is not proof that the edge cannot still apply a fetched command.
- [ ] Add delayed-reconciliation and in-flight RED tests. A delayed authenticated capability refresh that still advertises any protected token must leave the fence set. An authenticated refresh with all three tokens absent records the downgrade but clears the fence only when no protected `SENT`/`LEASED` command remains. If an ACK and mirror for an already-delivered command arrive after that capability downgrade, accept their normal terminal result, never re-lease the command, and clear the reconciled fence only after the lifecycle observer proves no executable protected work remains.
- [ ] In `CommandLeaseServicePostgresTest`, race leasing against fence activation under real row locks. The transaction must leave either a lease visible in the fence status (`safeToDowngrade == false`) or a fenced command that was never delivered. It must never report safe while a protected lease or SENT delivery exists.
- [ ] Run RED:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity/backend
./gradlew test --tests org.osi.server.device.DeviceConfigurationCommandServiceTest --tests org.osi.server.device.DeviceControllerTest --tests org.osi.server.device.DeviceServiceTest --tests org.osi.server.command.CommandLeaseServiceTest --tests org.osi.server.command.CommandLeaseServiceIT --tests org.osi.server.command.CommandLeaseServicePostgresTest --tests org.osi.server.command.CommandServiceTest --tests org.osi.server.command.GatewayCommandDeliveryFenceServiceTest --tests org.osi.server.command.GatewayCommandDeliveryFenceControllerTest --tests org.osi.server.user.LinkedGatewayAccountServiceTest
```

Expected: current endpoints mutate the cloud `Device` immediately and return 200.

- [ ] Implement `DeviceConfigurationCommandService` with resource type `DEVICE`, device EUI resource ID, base from the current DEVICE mirror/resource version, and the shared authorizer. Use `chameleon_config_commands_v1` and `device_soil_depth_commands_v1` independently.
- [ ] Stop calling `DeviceService.setChameleonEnabled` and `setSoilMoistureProbeDepths` from cloud request handling. Keep those methods only for edge mirror/application paths that write confirmed state.
- [ ] Desired payloads contain only the specific intended fields; response DTO exposes confirmed `Device` values and the pending operation separately.
- [ ] Implement `GatewayCommandCapabilityPolicy` as the single command-type-to-capability map. Apply capability and fence checks after candidate row locking and before leasing in `CommandLeaseService`, and before marking legacy candidates SENT in `CommandService`. Apply the same fence in all three protected issuance services. Unknown command families retain existing delivery behavior; the four protected command types have no permissive fallback. Treat each capability and the fence as gateway hardware truth shared across every `LinkedGatewayAccount` row for that gateway.
- [ ] Implement `GatewayCommandDeliveryFenceService.activate`, `status`, and `tryCompleteReconciliation`. Activation locks the gateway's linked-account rows, sets the durable fence everywhere, cancels only never-delivered PENDING protected commands, and returns the remaining executable counts. The controller is SUPER_ADMIN-only. It does not offer a force-clear operation.
- [ ] In `LinkedGatewayAccountService.applyEdgeCapabilities`, update all rows consistently and invoke `tryCompleteReconciliation` in the same transaction. A true report never clears an active fence. A false report marks capability reconciliation complete; the fence remains while protected SENT/LEASED work exists and clears after the last terminal ACK/mirror lifecycle callback. Accept that late terminal response even though capability is now false. Do not reclaim, re-lease, or convert an expired fetched command into evidence that rollback is safe. Test two linked accounts with inconsistent booleans and prove neither stale account state nor delayed refresh can reopen delivery.
- [ ] Remove `SET_CHAMELEON_CONFIG` and `UPSERT_DEVICE_SOIL_DEPTHS` from the exact cloud-deferred command set and matching staging fixture in the paired edge commit. Their edge runtime entries already exist but Task 9 still replaces permissive application with the protected exact-base route before capability advertisement.
- [ ] Run GREEN with the RED command. Expected: both routes are pending-first, the durable fence survives delayed refresh and in-flight completion, and existing unrelated device mutations remain green.
- [ ] Commit cloud: `feat(devices): gate delivery and make configuration pending-first`.
- [ ] Commit edge staging cleanup: `test(sync): activate cloud device configuration issuance`.

---

### Task 7: Add edge migration 0068, calibration events, and trusted terminal binding

**Repository:** `osi-os`

**Files:**
- Create: `database/migrations/ordered/0068__watermark_cloud_parity.sql`
- Modify: `database/seed-blank.sql`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js`
- Mirror the two helper files under `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/`
- Create: `scripts/rehearse-watermark-cloud-parity-migration.test.js`
- Modify: `scripts/verify-runtime-schema-parity.js`
- Modify: `scripts/verify-trigger-body-parity.js`
- Modify: `scripts/verify-db-schema-consistency.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-sync-op-parity.js`
- Modify: `scripts/fixtures/sync-contract-staging.json`
- Regenerate: all seven `farming.db` paths declared by `scripts/seed-db-paths.js`

- [ ] Write RED migration tests. Assert `0068` adds calibration outbox triggers only, never a `watermark_readings` trigger; preserves tombstones; emits one gateway/device-bound upsert/delete event; and adds trusted binding columns to `applied_commands` without losing existing rows.
- [ ] Write RED ledger tests for exact command-ID replay, same-intent effect-key replay, changed command ID with same effect/intent, changed actor/gateway/device/base/operation/intent, and ordering of command-ID before effect-key lookup.
- [ ] Run RED:

```bash
cd <osi-os>/.worktrees/watermark-cloud-parity
node --test scripts/rehearse-watermark-cloud-parity-migration.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
```

Expected: migration and trusted binding fields/logic are absent.

- [ ] Make `0068` additive. Add `binding_hash`, `intent_hash`, `resource_type`, `resource_id`, `gateway_device_eui`, `actor_user_uuid`, `base_sync_version`, and `operation` to `applied_commands`; add an index suitable for terminal effect-key lookup. Use names consistently in seed and tests.
- [ ] Add linked-gateway triggers on `watermark_calibrations` that emit the full live row or tombstone under `WATERMARK_CALIBRATION_UPSERTED`/`DELETED`, with uppercase device and resolved gateway.
- [ ] Extend `osi-command-ledger` with a protected configuration binding path. Its transaction order is: validate trusted context and semantic key; exact command-ID lookup and binding comparison; effect-key lookup and binding+intent comparison; otherwise allow the caller's mutation and terminal ledger write in the same transaction.
- [ ] Never treat a key match alone as a duplicate. Return a stable conflict for changed binding or intent and perform no mutation.
- [ ] Remove the two calibration events from `EXACT_EDGE_DEFERRED_OPS` and `eventOps.edgeDeferred` only after the migration triggers exist and the rehearsal proves their payload. The cloud-deferred entries were already removed in Task 4.
- [ ] Regenerate all seven seed images before running any seed/schema/profile parity gate:

```bash
node scripts/build-seed-db.js
```

Expected: the builder applies ordered migration 0068, verifies the head, and writes seven byte-identical ledger-bearing images.
- [ ] Run GREEN with the RED commands and:

```bash
node scripts/verify-runtime-schema-parity.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-seed-replay.js
node scripts/verify-seed-db-ledger.js
node scripts/verify-profile-parity.js
```

Expected: all pass.
- [ ] Commit: `feat(sync): add WATERMARK events and bound command ledger`.

---

### Task 8: Add one edge helper for exact-base configuration commands

**Repository:** `osi-os`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/calibration.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/index.js`
- Mirror all changed helper files under the bcm2709 path.
- Create: `scripts/test-watermark-cloud-command-auth.js`
- Modify: `deploy.sh`
- Modify: `scripts/deploy-fetch-list.test.js`
- Modify: `scripts/deploy-bundle.test.sh`
- Modify: `scripts/deploy-payload-lifecycle.test.js`
- Modify: `scripts/verify-module-file-deploy-coverage.js`

- [ ] Write RED tests for all four operations: calibration set, calibration delete, Chameleon set, soil-depth set. Cover stale base, foreign gateway, foreign device, missing actor, viewer, disabled account, absent grant, dangling/deleted/foreign assignment, assigned ADMIN without grant, valid assigned writer, and valid owner/admin when `irrigation_zone_id IS NULL`.
- [ ] Run RED:

```bash
cd <osi-os>/.worktrees/watermark-cloud-parity
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.test.js
node scripts/test-watermark-cloud-command-auth.js
```

Expected: command helper is absent.

- [ ] Extract transaction-scoped `saveCalibrationTx` and `deleteCalibrationTx` seams without changing local HTTP behavior. `commands.js` must call these same writers.
- [ ] Preserve phase-1 backfill behavior exactly while extracting the transaction seam: the calibration write and first `BACKFILL_BATCH_SIZE` batch (500 rows) commit atomically; continuation batches run one transaction at a time after that commit; a later-batch failure reports `backfill_incomplete` without rolling back the saved calibration. Add regression cases to `commands.test.js` and `store.test.js`.
- [ ] In scoped mode resolve the actor by gateway-local UUID, require enabled account and mutation-capable role, then apply the exact assigned/unassigned rule. Never accept a numeric cloud user ID. Under `OSI_SCOPED_ACCESS` off, preserve the current local-owner behavior; do not load `scope` at module initialization.
- [ ] For DEVICE commands, read current `devices.sync_version` under the transaction, require the exact base, call the same normalization/writer semantics as the local route, and increment once. Limit Chameleon to DRAGINO_LSN50 and soil-depths to the existing allowed device types.
- [ ] Persist mutation and terminal result/binding atomically. Return `CONFLICT` for stale base or binding/intent mismatch, `REJECTED_PERMANENT` for semantic/auth denial, and retryable failure only for infrastructure errors.
- [ ] Add `osi-watermark-helper/commands.js` to `deploy.sh` with `fetch_required` beside the existing WATERMARK helper files. Extend `scripts/deploy-fetch-list.test.js`, `scripts/deploy-bundle.test.sh`, and `scripts/verify-module-file-deploy-coverage.js` to prove the file is named in the deployment manifest and packed into the offline bundle. Extend `scripts/deploy-payload-lifecycle.test.js` with an ordering assertion that the helper is fetched, verified, and staged before the new `flows.json` can advertise capabilities; a bundle missing `commands.js` must fail before payload activation.
- [ ] Run GREEN with the RED commands plus:

```bash
node scripts/verify-auth-flag-off-hermetic.js
node scripts/verify-profile-parity.js
node scripts/deploy-fetch-list.test.js
scripts/deploy-bundle.test.sh
node scripts/deploy-payload-lifecycle.test.js
node scripts/verify-module-file-deploy-coverage.js
```

Expected: all pass.
- [ ] Commit: `feat(watermark): apply exact-base configuration commands`.

---

### Task 9: Wire edge commands, snapshots, and exact capabilities

**Repository:** `osi-os`

**Files:**
- Modify both profile `flows.json` files
- Create: `scripts/test-watermark-cloud-command-path.js`
- Create: `scripts/test-protected-config-command-dispatch.js`
- Create: `scripts/test-watermark-calibration-bootstrap.js`
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/test-journal-bootstrap.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-command-ack-postconditions.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

- [ ] Prove a no-op parse/stringify round-trip of canonical `flows.json` is byte-identical.
- [ ] Write RED wiring tests that require `cmd-type-registry` entries, fail-closed dispatch, a thin `watermark-config-command-apply-fn`, calibration snapshot arrays in `sync-bootstrap-build` and `sync-force-build`, and identical capabilities in all three builders.
- [ ] In `scripts/test-protected-config-command-dispatch.js`, exercise the real dedupe node, Route Command, protected helper, SQLite transaction, terminal ledger, and ACK outbox. For an existing `commandId`, vary actor, gateway, device, base, and normalized intent one at a time. Assert semantic trusted context is validated before exact-ID replay, every mismatch conflicts, legacy `applied_commands` rows without a binding hash fail closed, no premature ACK or mutation occurs, and an injected failure between mutation and terminal ACK persistence rolls back the mutation, ledger row, and ACK outbox together.
- [ ] Require exact capability arrays:

```text
watermark_v1
chameleon_config_commands_v1
device_soil_depth_commands_v1
```

Advertising means the corresponding exact-base applier and route are installed, not merely recognized by the registry.
- [ ] Run RED:

```bash
cd <osi-os>/.worktrees/watermark-cloud-parity
node scripts/test-watermark-cloud-command-path.js
node scripts/test-protected-config-command-dispatch.js
node scripts/test-watermark-calibration-bootstrap.js
node scripts/test-flows-wiring.js
node scripts/verify-sync-flow.js
```

Expected: new route/snapshot/capability assertions fail.

- [ ] Use a checked one-shot Node mutation script. Route the four commands to the helper and ACK output; do not let them fall through `Build UPDATE SQL` or another permissive handler. Remove `UPSERT_DEVICE_SOIL_DEPTHS` from the old raw SQL branch after the helper path is wired.
- [ ] Put the protected semantic-context gate before the generic exact-`commandId` replay branch. Only after gateway/device/actor/base/operation/effect-key/intent normalization succeeds may an exact-ID terminal result be returned. A legacy ledger row without the full binding is not replay evidence for these protected types.
- [ ] Add the calibration rows, including tombstones and their effective op, to bootstrap/force payloads after devices. Do not add `watermark_readings`.
- [ ] Add the exact three tokens to `sync-bootstrap-build`, `al-link-build-req`, and `sync-force-build`. Pin byte-equivalent capability sets in tests.
- [ ] Remove `SET_WATERMARK_CALIBRATION` and `DELETE_WATERMARK_CALIBRATION` from the exact edge-deferred command set and matching staging fixture only after this protected router is wired. `SET_CHAMELEON_CONFIG` and `UPSERT_DEVICE_SOIL_DEPTHS` were already runtime-recognized, but this task's tests must prove their old permissive apply path is gone before advertising their capabilities.
- [ ] Update the size ratchet with measured deltas and a narrow reason. Mirror flows byte-for-byte.
- [ ] Run GREEN with the RED commands plus:

```bash
node scripts/verify-command-ack-postconditions.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-flows-output-arity.js
node scripts/verify-profile-parity.js
node scripts/verify-no-new-silent-catch.js
scripts/check-mqtt-topics.sh
```

Expected: all pass.
- [ ] Commit: `feat(sync): wire WATERMARK parity commands and snapshots`.

---

### Task 10: Accept trusted FPort 11 contact in cloud, then publish it from edge

**Repositories:** `osi-server`, then `osi-os`

**Edge files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/ingest.js`
- Modify both profile `flows.json` files (`watermark-ingest-fn` and its MQTT output wiring)
- Modify: `scripts/test-watermark-ingest-flow.js`
- Create: `scripts/test-watermark-contact-payload.js`

**Cloud files:**
- Modify: `backend/src/main/java/org/osi/server/mqtt/MqttMessageRouter.java`
- Modify: `backend/src/main/java/org/osi/server/device/DeviceService.java`
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java`
- Modify: `backend/src/main/java/org/osi/server/device/DeviceResponseMapper.java`
- Modify: `backend/src/test/java/org/osi/server/mqtt/MqttMessageRouterTest.java`
- Modify: `backend/src/test/java/org/osi/server/device/DeviceServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/device/DeviceControllerTest.java`

- [ ] Write cloud RED tests with `0016C001F1000001`, `A840410000000001`, and `A840410000000002` as the gateway, device, and foreign-device fixtures. On the gateway-forwarded sensor branch only, cover new-device binding through the four-argument `upsertFromHeartbeat`, matching existing binding, foreign binding rejection, null-bound existing device rejection, monotonic contact, no `SensorData`, no current-state change, and no `currentStateRecordedAt` change. Pin ordinary gateway/direct heartbeat behavior unchanged through the existing three-argument path.
- [ ] Add accepted-canonical-frame tests proving `currentStateRecordedAt` may advance with null channel values; rejected contact cannot advance it. For DRAGINO_LSN50 responses, assert `lastSeen` is contact time, `currentStateRecordedAt` is separate measurement time, and online derives from `lastSeen`. Add unchanged-presentation regression tests for STREGA, gateway, KIWI/Clover, SDI-12, S2120, and other device responses; do not globally change their `effectiveObservedAt` presentation in this task.
- [ ] Run cloud RED first:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity/backend
./gradlew test --tests org.osi.server.mqtt.MqttMessageRouterTest --tests org.osi.server.device.DeviceServiceTest --tests org.osi.server.device.DeviceControllerTest
```

Expected: the forwarded branch uses the three-argument writer and LSN50 response `lastSeen` currently uses `effectiveObservedAt`.

- [ ] Cloud: in `MqttMessageRouter.handleTelemetry`, derive gateway EUI only from the authenticated MQTT topic. On the gateway-forwarded sensor branch call `upsertFromHeartbeat(sensorEui, type, null, topicGatewayEui)`. Update an existing row only for an equal non-null binding; reject foreign and null-bound rows without touching `lastSeen`. Never repair a null binding from MQTT. Leave `handleHeartbeat` and non-forwarded telemetry on their current behavior.
- [ ] Make `DeviceService` timestamp updates monotonic. Do not call `updateCurrentState` or `sensorDataRepository.upsertSensorData` for contact-only envelopes.
- [ ] In `DeviceController.DeviceResponse` and `DeviceResponseMapper`, apply contact-based `lastSeen`, separate `currentStateRecordedAt`, and contact-based online state only when `type == DRAGINO_LSN50`. Preserve current response semantics for STREGA, gateways, and every other device type. Keep `Device.effectiveObservedAt()` unchanged.
- [ ] Run cloud GREEN with the cloud RED command and commit cloud: `feat(devices): bind WATERMARK contact to trusted gateway`.
- [ ] Write edge RED tests proving accepted, calibration-missing, channel-invalid, and frame-rejected attributable FPort 11 uplinks emit a contact envelope with only trusted gateway identity, child device identity, device type, port, and observed time. Assert forbidden keys and nested diagnostics are absent.
- [ ] Run edge RED:

```bash
cd <osi-os>/.worktrees/watermark-cloud-parity
node scripts/test-watermark-ingest-flow.js
node scripts/test-watermark-contact-payload.js
```

Expected: edge emits no FPort 11 contact.
- [ ] Edge: emit exactly one contact-only message from `watermark-ingest-fn` after structural attribution, regardless of conversion/calibration success. Preserve the generic `Build Telemetry` FPort 11 drop and FPort 2 behavior.
- [ ] Run edge GREEN with the edge RED commands. Expected: all pass and no raw key appears in MQTT fixtures.
- [ ] Commit edge: `feat(watermark): publish FPort 11 contact only`.

---

### Task 11: Build the cloud card, pending edit flows, and neutral history labels

**Repository:** `osi-server`

**Files:**
- Modify: `frontend/src/types/farming.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/contexts/GatewayContext.tsx`
- Modify: `frontend/src/contexts/gatewayCapabilities.ts`
- Modify: `frontend/src/components/farming/DraginoCard.tsx`
- Create: `frontend/src/components/farming/WatermarkCloudSection.tsx`
- Create: `frontend/src/components/farming/WatermarkCalibrationPanel.tsx`
- Modify: `frontend/src/components/farming/KiwiSensorCard.tsx`
- Modify: `frontend/src/components/farming/zoneSensorPresence.ts`
- Modify: `frontend/src/channels/channels.json`
- Modify: `frontend/src/channels/registry.ts`
- Modify: `backend/src/main/java/org/osi/server/history/HistoryCardService.java`
- Modify: `backend/src/main/java/org/osi/server/analysis/AnalysisCatalogService.java`
- Create: `frontend/src/components/farming/__tests__/WatermarkCalibrationPanel.test.tsx`
- Create: `frontend/src/components/farming/__tests__/DraginoCard.watermark.test.tsx`
- Create: `frontend/src/contexts/__tests__/gatewayCapabilities.watermark.test.ts`
- Modify: `frontend/src/channels/__tests__/registry.test.ts`
- Modify: `backend/src/test/java/org/osi/server/history/HistoryCardServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/analysis/AnalysisCatalogServiceTest.java`
- Modify all existing locale files under `frontend/public/locales/*/devices.json`; keep `lg` equal to `en`.

- [ ] In `WatermarkCalibrationPanel.test.tsx`, write RED tests for confirmed calibration, pending set/delete, failure/conflict, metadata clear, and pending values remaining separate from confirmed values after refresh.
- [ ] In `DraginoCard.watermark.test.tsx`, render the real `DraginoCard`, open its actual configuration entry point, click the WATERMARK panel control, edit, and submit through the API mock. Assert an LSN50 with no calibration ever configured is still eligible when the active gateway advertises `watermark_v1`; loading, absent capability, downgrade, or viewer state removes/disables edits. Also cover contact age versus measurement age, Chameleon pending toggle, and depth pending form.
- [ ] In `gatewayCapabilities.watermark.test.ts`, pin each exact capability independently and fail closed during loading/error/no active gateway. In `registry.test.ts`, `HistoryCardServiceTest`, and `AnalysisCatalogServiceTest`, pin labels exactly to “Soil tension 1” and “Soil tension 2” before and after calibration, Chameleon toggle, and delete.
- [ ] Add backend cases in which a DRAGINO_LSN50 has canonical `swt_1`/`swt_2` history but no current calibration mirror, no WATERMARK provenance, and `chameleonEnabled == 0`. It must still classify as a soil source and appear in `AnalysisCatalogService`; classification must not consult current calibration state.
- [ ] Run RED:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity/frontend
npx vitest run --environment jsdom src/components/farming/__tests__/WatermarkCalibrationPanel.test.tsx src/components/farming/__tests__/DraginoCard.watermark.test.tsx src/contexts/__tests__/gatewayCapabilities.watermark.test.ts src/channels/__tests__/registry.test.ts
cd ../backend
./gradlew test --tests org.osi.server.history.HistoryCardServiceTest --tests org.osi.server.analysis.AnalysisCatalogServiceTest
```

Expected: API types/components/capability helpers are absent or current labels are not pinned to the neutral wording.

- [ ] Add the three capability booleans to gateway types and helpers. Helpers fail closed while loading, on error, without active gateway, or when the exact boolean is false.
- [ ] Add calibration GET/PUT/DELETE service methods and desired-state response types. Treat HTTP 202 as queued, not applied.
- [ ] Mount `WatermarkCloudSection` from the real `DraginoCard` configuration entry point. Eligibility is `device.type == DRAGINO_LSN50` plus active-gateway `watermarkSupported == true`; calibration existence is not an eligibility condition, so a never-configured LSN50 can open the form. Show “Calibration configured” as configuration state only, confirmed versus pending values, contact age, measurement age, and neutral soil-tension channels. Do not show board temperature, supply, status flags, resistance, offset, or conversion versions.
- [ ] Convert the existing Chameleon toggle and generic depth editors to the 202/pending flow. Remove edit controls after capability downgrade; leave queued work visible as unsupported/pending rather than routing it elsewhere.
- [ ] Update `channels.json` and registry so `swt_1`/`swt_2` use neutral labels. Make `HistoryCardService.isSoilSourceDevice` classify `DRAGINO_LSN50` independently of current calibration, Chameleon enablement, or provenance; make `soilChannelsForDevice` return its canonical `swt_1`/`swt_2` channels; and keep `AnalysisCatalogService.addSoilDeviceEntries` on that shared classification. Never use the calibration mirror to relabel or classify historical rows.
- [ ] Run GREEN with the RED commands, then:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity/frontend
npx tsc --noEmit
npm run test:unit
npm run build
```

Expected: all pass; only one frontend build runs.
- [ ] Commit: `feat(watermark): add cloud calibration and neutral history UI`.

---

### Task 12: Regenerate seeds, update operational docs, and run complete verification

**Repositories:** `osi-os`, then `osi-server`

**Edge files:**
- Regenerate the seven paths declared by `scripts/seed-db-paths.js`
- Modify: `AGENTS.md`
- Modify: `docs/contracts/sync-schema/README.md`
- Modify: `docs/superpowers/plans/2026-09-29-watermark-deferred-work.md`
- Modify: `docs/operations/watermark-field-qualification.md`

**Cloud files:**
- Modify: `AGENTS.md`
- Create: `backend/src/test/java/org/osi/server/sync/WatermarkCloudParityReconciliationIT.java`

- [ ] Run the focused migration and trigger suites from Tasks 7–9. Stop if any fail.
- [ ] Re-run the sanctioned seed builder used first in Task 7 so the final rebased migration set, not an earlier intermediate tree, stamps every bundled database:

```bash
cd <osi-os>/.worktrees/watermark-cloud-parity
node scripts/build-seed-db.js
```

Expected: seven images written from one verified ledger-bearing image.

- [ ] Document the three capability tokens, two events, four commands, exact effect keys, cloud-first rollout order, contact/measurement timestamp split, raw-data exclusion, and scheduler interlock. Add a “Cloud parity evidence” checklist to `watermark-field-qualification.md` that records the confirmed calibration version, pending/applied command state, contact and measurement times, and absence of raw diagnostics; it must state that these records do not qualify samples for scheduler use. Mark the old Phase 2/3 plans historical; do not restate them as executable alternatives.
- [ ] Create `WatermarkCloudParityReconciliationIT` as the deployment-free cross-slice test. Prove: calibration saved before link arrives by bootstrap; a retained tombstone supplies the next base; ACK without mirror stays pending; mirror without ACK stays pending; later replay plus mirror applies; and a downgraded gateway cannot receive new work. Run `cd <osi-server>/.worktrees/watermark-cloud-parity/backend && ./gradlew test --tests org.osi.server.sync.WatermarkCloudParityReconciliationIT`; expected: PASS before the full suites below.
- [ ] Run complete edge verification:

```bash
cd <osi-os>/.worktrees/watermark-cloud-parity
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-op-parity.js
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-seed-db-ledger.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-profile-parity.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-flows-output-arity.js
node scripts/flows-bare-require-scan.js
scripts/check-mqtt-topics.sh
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/conversion.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/store.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.test.js
node --test scripts/rehearse-watermark-cloud-parity-migration.test.js
node scripts/test-watermark-calibration-routes.js
node scripts/test-watermark-ingest-flow.js
node scripts/test-watermark-contact-payload.js
node scripts/test-watermark-cloud-command-auth.js
node scripts/test-watermark-cloud-command-path.js
node scripts/test-protected-config-command-dispatch.js
node scripts/test-watermark-calibration-bootstrap.js
node scripts/deploy-fetch-list.test.js
scripts/deploy-bundle.test.sh
node scripts/deploy-payload-lifecycle.test.js
node scripts/verify-module-file-deploy-coverage.js
```

Expected: every command exits zero; both profile payloads and all seven seeds agree; no raw WATERMARK diagnostic appears in a contract, snapshot, or contact fixture.

- [ ] Run complete cloud verification:

```bash
cd <osi-server>/.worktrees/watermark-cloud-parity
sh scripts/verify-flyway-ordering.sh
EDGE_CONTRACT_ROOT=<osi-os>/.worktrees/watermark-cloud-parity sh scripts/verify-edge-sync-contract-vendor.sh
cd backend
./gradlew test
./gradlew build
cd ../frontend
npx tsc --noEmit
npm run test:unit
npm run build
```

Expected: every command exits zero. If `origin/main` acquired a newer migration, rename `V2026_09_30_001__watermark_cloud_parity.sql` strictly after it, update references in this plan/docs/tests, and rerun ordering plus the full backend suite.

- [ ] Run documentation and whitespace checks:

```bash
cd <osi-os>/.worktrees/watermark-cloud-parity
node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-09-30-watermark-cloud-parity.md docs/superpowers/specs/2026-09-30-watermark-cloud-parity-design.md docs/contracts/sync-schema/README.md docs/superpowers/plans/2026-09-29-watermark-deferred-work.md docs/operations/watermark-field-qualification.md AGENTS.md
git diff --check origin/main --
cd <osi-server>/.worktrees/watermark-cloud-parity
git diff --check origin/main --
```

Expected: zero slop findings and no whitespace errors.
- [ ] Commit edge: `build(watermark): regenerate parity seeds and document rollout`.
- [ ] Commit cloud: `docs(watermark): record cloud parity contract and rollout`.

---

## Paired Landing and Rollout

1. Merge the `osi-server` desired-state guard from Task 1.
2. Merge the canonical `osi-os` contract commit from Task 2, then its paired `osi-server` vendor commit. This is contract publication, not edge producer enablement.
3. Merge the cloud commits from Tasks 3–6, the cloud half of Task 10, and Task 11. Deploy and verify cloud migrations, contract acceptance, appliers, APIs, capability-aware leasing, trusted forwarded-contact handling, DTO/timestamp semantics, capability defaults, and neutral read-only UI while all new capability booleans remain false.
4. Merge the edge commits from Tasks 7–9, the edge half of Task 10, and the edge half of Task 12. Only this release advertises `watermark_v1`, `chameleon_config_commands_v1`, and `device_soil_depth_commands_v1` or begins publishing contact-only FPort 11 messages.
5. Force/bootstrap-sync a non-production fixture gateway. Verify pre-existing calibration and tombstone convergence before using any cloud edit control.
6. Confirm post-rollout evidence without production access in this plan: capability summary contains exactly the installed tokens; calibration command remains pending until ACK plus mirror; contact advances `lastSeen` only; measurement advances `currentStateRecordedAt`; no raw diagnostic field appears; scheduler exclusion tests remain green.
7. Before a planned edge rollback, activate the protected-command delivery fence while the capability-advertising edge is still installed. Confirm the cloud has disabled all three protected edit families and both pending-command protocols. The fence may cancel never-delivered PENDING work; wait for every SENT or LEASED command to return a terminal response. If `safeToDowngrade` is false or any protected PENDING/SENT/LEASED count is nonzero, abort the rollback.
8. Deploy the downgraded edge only after the fence status is safe. Keep the fence persisted while capability refresh is delayed; a late report that still advertises any protected token cannot clear it. Force an authenticated bootstrap/capability refresh from the downgraded edge and confirm all three tokens are absent. The cloud may clear the fence only after that reconciliation and a second zero-executable-work check; false capabilities then keep issuance and delivery closed.
9. Treat a terminal response that races across downgrade as valid for its already-delivered command: record its ACK/mirror convergence, never re-lease it, and keep the fence until no executable protected work remains. Keep cloud event acceptance deployed while any 0068 edge may still exist because those persistent triggers can continue emitting calibration events. This plan makes no independent cloud-rollback guarantee.

## Definition of Done

- All acceptance conditions in §12 of the design have executable tests.
- Cloud writes are pending-first and exact-base for calibration, Chameleon, and depths.
- Both command issuance and edge application pass the complete negative authorization matrix.
- Terminal replay is bound to trusted context and normalized intent.
- Bootstrap handles retained tombstones, stale input, lost events, missing parents, and equal-version divergence without manufacturing ACKs.
- FPort 11 contact and canonical measurement timestamps are independent and monotonic.
- No raw WATERMARK diagnostics sync; neutral history labels and scheduler interlock remain intact.
- Cloud deploys before capability-advertising edge code.
- Planned downgrade uses the durable delivery fence, reaches zero executable protected work before edge replacement, and remains fenced through authenticated capability reconciliation.
- Full edge/cloud verification, anti-slop checks, and `git diff --check` pass on the final rebased branches.
