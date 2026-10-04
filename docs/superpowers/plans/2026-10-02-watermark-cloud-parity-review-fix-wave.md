# WATERMARK cloud parity review fix wave

This plan fixes the 16 review findings on the two integration branches. Execute the tasks in order, add the stated RED coverage before implementation, and make one finding commit per task.

## Global constraints

- Work only on `integrate/watermark-cloud-parity` in the `osi-os` and `osi-server` integration worktrees. Do not push, merge, deploy, or contact a gateway or cloud host.
- Do not weaken, skip, or delete assertions to obtain GREEN. The owner authorized the identified expectation corrections: E3 changes `scripts/test-protected-config-command-dispatch.js:162` to preserve the original durable ACK; C7 changes the stale-retention expectation for the protected `SET_CHAMELEON_CONFIG` row in `DeviceCommandRepositoryDbTest.commandRetentionSqlUpdatesOnlyStaleConfigAndDeletesTerminalRows` so unresolved protected evidence is preserved, while a separate legacy fixture continues proving expiry; E1 removes the dendrometer from the soil count/list at both profiles' `osi-history-helper/index.test.js:212-215`; C4 restores absent-tile expectations at `frontend/src/components/farming/__tests__/IrrigationZoneCardWaterHonesty.test.tsx:221-222`; E6 changes only the dead `capability_missing` expectations identified in its task. Add failing coverage for the corrected behavior first. The plain-LSN50 assertion at helper test line 252 remains valid; narrow its misleading “every assigned LSN50” title. Stop for any other incorrect existing expectation. Do not recapture golden vectors.
- Command issuance is not delivery. Protected commands remain `PENDING` after issuance and skip MQTT `SENT`. An active downgrade fence blocks new issuance and first REST delivery. It permits immutable replay only after prior edge exposure and only while the gateway still reports the required capability.
- A protected command is resolved only when either (a) both an authoritative `APPLIED`/`ACKED` result and mirror convergence to the intended edge value have arrived, in either order, or (b) an authoritative edge ACK definitively says the mutation was not applied. Case (b) settles without desired-mirror convergence. Cloud timeout, retry exhaustion, cancellation after exposure, an expired lease, and a lost response do not resolve a command.
- The unresolved count is the number of gateway-scoped protected desired operations that have neither converged after application nor received a definitive non-application edge ACK, excluding only never-exposed operations canceled atomically with their command. `safeToDowngrade` means an active fence, unresolved count zero, and malformed protected-delivery count zero. Use one lock order across issuance, leasing, cancellation, REST/MQTT ACKs, and mirror convergence: canonical device/resource, gateway/membership, command, desired operation. Within a class, lock multiple rows in stable key order. A gateway-only fence transaction must never acquire a device/resource lock afterward. Audit `DeviceConfigurationCommandService`, `WatermarkCalibrationCommandService`, `DesiredStateService`, and `SyncEventTxExecutor` against this order.
- Preserve edge authority. Command bases come only from confirmed edge canonical versions. Pending desired values, cloud-side renames, and cloud mirror rows cannot advance a base.
- Preserve `DEVICE_DATA` ingestion/history projections, v1/v2 canonicalization, and raw diagnostic storage. This wave must not change those paths.
- Keep edge migration `0068` and Flyway migration `V2026_09_30_001`. If a migration or seed input changes, run `node scripts/build-seed-db.js`; do not trust merged `farming.db`, `CHECKSUMS.json`, or size-allowance files.
- Keep both edge `flows.json` files byte-identical. After a flow change, remeasure the size ratchet by the documented recipe. Scheduler node `d0b2b1c1a937e16d` must remain byte-identical to `main`.
- Use only fixtures in the documented `A840410000000001` and `0016C001F1000001` ranges. Do not add customer, farm, gateway, tailnet, or developer-local identifiers.
- Use a private directory below `/var/tmp` for temporary files and remove only that directory. Never run two frontend builds concurrently.
- Gateways missing the new capability tokens still receive “not supported” for the Chameleon toggle and KIWI/Clover depth edits. Document that `SET_CHAMELEON_CONFIG` changes `chameleon_enabled`, which controls scheduler eligibility, while WATERMARK rows remain excluded.
- Keep neutral channel labels. Retain the edge helper's legacy `(S1)/(S2)` export labels unless an existing contract test proves that changing them is safe.
- Stage this plan file in the E2 documentation commit, `fix(E2): preserve legacy soil depth commands`. This keeps the one-commit-per-finding history without an extra planning-only commit.
- Command working directories: every `./gradlew` command runs from `osi-server/backend`; cloud shell verifiers run from the server repository root. Frontend commands run in `frontend` or `terra-intelligence` as named. Each command starts in its stated directory, independent of the previous command.

## Tasks

### Task 1: C1 — supply protected command IDs

  - Repo/files/tests: `osi-server`; `DeviceConfigurationCommandService.java`, vendored `commands.schema.json`, `DeviceConfigurationCommandServiceTest.java`, and `backend/src/test/java/org/osi/server/sync/SyncContractVendorTest.java`. The edge contract reference is `osi-watermark-helper/commands.js`.
  - RED: run `./gradlew test --tests DeviceConfigurationCommandServiceTest --tests SyncContractVendorTest`; add assertions that issued `SET_CHAMELEON_CONFIG` and `UPSERT_DEVICE_SOIL_DEPTHS` payloads contain a persisted canonical UUID `command_id`, distinct from the numeric transport command ID, then observe failure.
  - Invariant: generate one stable payload UUID at issuance, persist it, and serialize that UUID on every first delivery and replay. Preserve the numeric transport ID for transport ACK correlation. Add an interoperability fixture passing both cloud-produced payloads to the production edge helper and asserting acceptance and ACK correlation.
  - GREEN: rerun the RED command with `EDGE_CONTRACT_ROOT` set to the paired edge checkout, run the focused interoperability fixture, then run `EDGE_CONTRACT_ROOT="$EDGE_WORKTREE" sh scripts/verify-edge-sync-contract-vendor.sh` from the server root.
  - Commit: `fix(C1): include command IDs in protected device commands`

### Task 2: E3 — replay the stored terminal result without mutating evidence

  - Repo/files/tests: `osi-os`; both profile copies of `osi-watermark-helper/commands.js`, `osi-command-ledger/index.js`, `osi-command-ledger/index.test.js`, the WATERMARK command tests, `scripts/test-protected-config-command-dispatch.js`, and a new focused `scripts/test-protected-command-replay-chain.js`.
  - RED: run both profile ledger tests, `node scripts/test-watermark-cloud-command-path.js`, and `node scripts/test-protected-command-replay-chain.js`. The focused probe executes the shipped dedupe, protected helper, and `Queue REST Command ACK` function bodies with a real database. Cover a valid exact replay and same-ID changed binding. Correct only the authorized durable-ACK expectation at dispatch test line 162. Do not run the full dispatch gate before T1.
  - Invariant: valid exact replay returns the stored result and ACK. Same-ID changed binding is rejected, but the existing terminal ledger row and original durable ACK/outbox row remain unchanged. Assert unchanged `result_detail` and `payload_json` before and after both paths.
  - GREEN: rerun both profile ledger tests, `node scripts/test-watermark-cloud-command-path.js`, and the focused replay-chain probe; compare stored `result_detail` and ACK/outbox `payload_json` byte-for-byte after the actual ACK queue node has executed. The full dispatch gate remains scheduled for T1.
  - Commit: `fix(E3): preserve terminal results during replay`

### Task 3: E5 — scope terminal conflicts to protected commands

  - Repo/files/tests: `osi-os`; both profile copies of `osi-command-ledger/index.js` and `osi-command-ledger/index.test.js`.
  - RED: run both profile `osi-command-ledger/index.test.js` files; add a legacy command conflict case that currently becomes terminal.
  - Invariant: only the four protected exact-base types treat `CONFLICT` as terminal. All other command types retain their prior retry semantics.
  - GREEN: rerun both ledger suites with one protected and one legacy conflict, then `node scripts/verify-profile-parity.js`.
  - Commit: `fix(E5): scope terminal conflicts to protected commands`

### Task 4: C3 — separate issuer authorization from gateway capability

  - Repo/files/tests: `osi-server`; sync-token issuance/claims, `EdgeSyncController.java`, `EdgeSyncService.java`, `LinkedGatewayAccountService.java`, `LocalSyncService.java`, `GatewayCommandCapabilityPolicy.java`, `GatewayCommandDeliveryFenceService.java`, additive Flyway state, and their focused unit/Postgres tests.
  - RED: run the focused token, controller, capability-policy, linked-account, bootstrap, and `GatewayCommandDeliveryFencePostgresTest` suites. Cover an active issuer plus disabled sibling, disabled-only rows, an authenticated newer presence followed by an older omission replay, equal-version conflict/idempotency, a later member, legacy tokens, forged body versions, and empty bootstrap membership.
  - Invariant: `gatewayDisabledAt` controls only the member's authority to issue. Protected hardware truth is gateway-wide and ordered by a positive database-sequenced claim minted into the cloud's verified gateway-bound sync token, never by receipt time, client clocks, or a request-body version. Local link establishes membership but not protected hardware truth. Missing/older reports preserve confirmed state; newer reports replace it atomically; equal identical reports are idempotent and initialize later members; equal conflicting reports fail closed until a newer token. Ordinary bootstrap continues and returns a replacement sync token through the existing response fields when capability evidence is not accepted. Only a fresh accepted omission may establish absence, and it cannot clear a fence while unresolved work remains.
  - GREEN: rerun the RED command plus Flyway ordering. Prove real token sequence monotonicity, intact old-request replay protection, current-edge token upgrade/adoption, multi-member correctness, active-member delivery, disabled-member issuance denial, and that neither disabled nor stale rows make the fence safe. Do not add an edge migration or edge C3 commit.
  - Commit: `fix(C3): separate gateway capability from member status`

### Task 5: C7 — implement protected lifecycle cancellation and retention primitives

  - Repo/files/tests: `osi-server`; `CommandLeaseService.java`, `CommandService.java`, `CommandAckController.java`, `DeviceCommandRepository.java`, desired-operation service/repository classes, and new `ProtectedCommandCancellationService`, controller, and authorization tests. Cover `DeviceCommandRepositoryDbTest`, `CommandRetentionJobTest`, `CommandAckControllerTest`, and `CommandLeaseServicePostgresTest`.
  - RED: run `./gradlew test --tests DeviceCommandRepositoryDbTest --tests CommandRetentionJobTest --tests ProtectedCommandCancellationServiceTest --tests CommandAckControllerTest --tests CommandLeaseServicePostgresTest`; add unexposed cancellation, exposed refusal, expired-lease replay, atomic rollback, and a barrier-controlled cancellation-versus-first-lease race. Send real `FAILED_RETRYABLE` ACKs beyond the configured attempt limit, then run leasing and retention.
  - Invariant: add `POST /api/v1/gateways/{gatewayEui}/protected-commands/{commandId}/cancel`. Only the creator or a principal authorized for that gateway may call it. Under the global lock order, cancel only proven-unexposed work and update its desired operation in the same transaction. Return a defined refusal for exposed work. Expired leases and exhausted retryable ACKs remain replayable and unresolved; cloud retry exhaustion must not synthesize an authoritative `REJECTED_PERMANENT`. Retention preserves their command and desired-operation evidence, along with all exposed or unconverged protected work.
  - GREEN: rerun the RED command and controller authorization test. Prove exactly one cancellation/first-exposure outcome wins; retry exhaustion stays replayable after retention and settles only after a real terminal edge ACK, with mirror convergence also required for applied work.
  - Commit: `fix(C7): add safe protected command cancellation`

### Task 6: C2 — make the downgrade fence policy drainable

  - Repo/files/tests: `osi-server`; `CommandService.java`, `GatewayCommandCapabilityPolicy.java`, `CommandLeaseService.java`, `DeviceCommandRepository.java`, ACK controller/service, desired-state convergence service/repository, `GatewayCommandDeliveryFenceService.java`, and `GatewayCommandDeliveryFencePostgresTest`.
  - RED: run `./gradlew test --tests GatewayCommandDeliveryFencePostgresTest --tests CommandAckControllerTest --tests CommandLeaseServicePostgresTest`. Drive production services through (1) issue -> activate fence before REST poll -> atomically cancel -> no delivery; (2) issue -> REST exposure -> lose response -> activate fence -> immutable replay while capability remains -> authoritative result plus mirror convergence -> drain. For all four protected types, cover capability disappearance and exhausted `FAILED_RETRYABLE` ACKs followed by retention and replay. Add barrier-controlled concurrent ACK/fence activation.
  - Invariant: C2 consumes the C7 primitives. The fence blocks issuance and first delivery, permits only immutable replay of exposed commands while capability remains, and is safe only when active with zero unresolved operations and zero malformed protected deliveries. Capability disappearance leaves exposed work unsafe. ACK handling and fence activation obey the global lock order; gateway-only fence activation never locks a device afterward.
  - GREEN: rerun the RED command; sequence 1 has no edge exposure, sequence 2 drains only after authoritative result plus convergence, capability loss, retry exhaustion, and malformed protected delivery stay unsafe, and concurrent transactions finish without deadlock or lost state.
  - Commit: `fix(C2): make protected command fences drain safely`

### Task 7: C8 — serialize device protected mutations against confirmed state

  - Repo/files/tests: `osi-server`; `DeviceConfigurationCommandService.java`, `WatermarkCalibrationCommandService.java`, `DeviceService.java`, `DesiredStateService`, desired-state repository, `SyncEventTxExecutor.java`, `DesiredStateServiceTest`, `DesiredStateConvergenceIT`, and `DeviceConfigurationCommandPostgresTest`.
  - RED: run `./gradlew test --tests DesiredStateServiceTest --tests DesiredStateConvergenceIT --tests DeviceConfigurationCommandPostgresTest`. Cover cross-type overlap, same-type rewrite before/after exposure, missing canonical version, and cloud rename drift. Drive repeated unexposed edits -> one REST exposure -> real ACK plus matching mirror -> unresolved count zero. Use barriers for issuance versus cancellation/first lease and ACK versus mirror. Cover mirror-before-ACK, duplicate ACK/mirror, divergent mirror followed by definitive non-application, and divergent mirror followed by later matching convergence.
  - Invariant: a same-type mutation may rewrite only proven-unexposed work, preserving one logical desired operation or atomically canceling/replacing the old command-operation pair. Never leave an executable superseded predecessor or an orphan unresolved operation attached to a reused command. Refuse exposed same-type replacements. Cross-type DEVICE mutation conflicts until the earlier operation resolves through convergence, C7 cancellation, or authoritative definitive non-application. Those same resolution conditions allow a successor. Compute bases only from confirmed edge canonical state; missing versions return reconciliation-required. Follow the global lock order across issuance, ACKs, and canonical mirror updates.
  - GREEN: rerun the RED command. Assert exact replacement/refusal rules, no lost updates or deadlocks, one resolvable command-operation pair after repeated edits, and zero unresolved operations after either valid terminal sequence regardless of ACK/mirror ordering or duplicates.
  - Commit: `fix(C8): serialize protected device mutations`

### Task 8: C9 — fix transaction, timestamp, schema, and localization drift

  - Repo/files/tests: `osi-server`; `DeviceService.java`, `MqttMessageRouter.java`, `WatermarkCalibrationCommandService.java`, vendored `commands.schema.json`, `WatermarkCalibrationPanel.tsx`, `WatermarkCloudSection.tsx`, backend integration tests, locale resources, and panel tests.
  - RED: add `backend/src/test/java/org/osi/server/device/WatermarkContactJoinedTransactionIT.java`: dirty an unrelated managed entity in an outer transaction, call the production contact service, then commit and verify both writes. Run `./gradlew test --tests WatermarkContactJoinedTransactionIT --tests WatermarkContactCanonicalIT --tests WatermarkContactConcurrencyIT --tests SyncContractVendorTest` with `EDGE_CONTRACT_ROOT` set. Add a direct schema assertion for `requested_at`; the vendor script excludes `commands.schema.json`. Create the missing `frontend/src/components/farming/__tests__/WatermarkCloudSection.test.tsx` and extend the existing sibling `WatermarkCalibrationPanel.test.tsx` with a real non-English locale.
  - Invariant: never clear a caller-owned persistence context. Clamp contact time monotonically to accepted bounds under concurrency. Allow canonical edge `requested_at` in the vendored schema and assert direct equality with the edge command schema. Move both English strings into locale resources and verify a real non-English locale.
  - GREEN: rerun the RED Gradle command. From `frontend`, run `npx tsc --noEmit` and `npx vitest run src/components/farming/__tests__/WatermarkCalibrationPanel.test.tsx src/components/farming/__tests__/WatermarkCloudSection.test.tsx`. From the server root, run `EDGE_CONTRACT_ROOT="$EDGE_WORKTREE" sh scripts/verify-edge-sync-contract-vendor.sh`.
  - Commit: `fix(C9): align watermark transactions timestamps and copy`

### Task 9: C5 — isolate foreign calibration rows in bootstrap

  - Repo/files/tests: `osi-server`; `WatermarkCalibrationApplier.java`, `EdgeSyncService.java`, `SyncEventTxExecutor.java`, `EdgeSyncServiceBootstrapTest`, and new `backend/src/test/java/org/osi/server/sync/WatermarkBootstrapOwnershipIT.java`.
  - RED: run `./gradlew test --tests EdgeSyncServiceBootstrapTest --tests WatermarkBootstrapOwnershipIT`. Add payload-owner/device-owner/mirror-owner mismatch cases alongside valid calibration and ordinary device rows. The integration test must use Spring transaction proxies and Postgres, then verify committed state from a new transaction; the existing Mockito bootstrap test cannot prove this.
  - Invariant: validate all calibration ownership inputs before any mutation. Skip only the foreign calibration row and record one stable rejected-ownership reason. Handle that rejection before an exception crosses `SyncEventTxExecutor.applyRetainedWatermarkCalibration`'s `MANDATORY` transaction proxy and poisons the outer bootstrap, or use an equally narrow non-rollback result. Never swallow a rollback-only transaction or change ordinary device/event ownership rejection. Rejected calibration rows leave the retained mirror, resource watermark, and desired-state convergence unchanged.
  - GREEN: rerun the RED command; prove valid calibration and ordinary device rows commit despite each isolated mismatch, with one stable rejection reason and no partial mutation of rejected calibration state.
  - Commit: `fix(C5): isolate foreign bootstrap calibrations`

### Task 10: C6 — restore null-bound durable history and contact handling

  - Repo/files/tests: `osi-server`; `EdgeSyncService.java`, `DeviceService.java`, `EdgeSyncServiceHistoryOwnershipTest`, `WatermarkContactCanonicalIT`, `WatermarkContactConcurrencyIT`, and WATERMARK design sections 6-7.
  - RED: run `./gradlew test --tests EdgeSyncServiceHistoryOwnershipTest --tests WatermarkContactCanonicalIT --tests WatermarkContactConcurrencyIT`; add null-bound KIWI, Clover, LSN50, S2120, SDI12, and LoRain history/contact cases plus STREGA and different-owner cases. Concurrent reassignment tests must execute durable history writes and contact updates, not only the ownership precheck.
  - Invariant: restore only durable-history acceptance for null-bound sensor devices; do not loosen `EdgeOwnershipService`. Null-bound history remains ownerless. Forwarded contact updates only monotonic `lastSeen`, never canonical state or ownership. Preserve the separate null-bound STREGA observation and MQTT-history path; do not fold it into sensor contact-only semantics. Reject a different non-null owner, including a concurrent reassignment won by another gateway.
  - GREEN: rerun the RED command; assert ownership stays null, only `lastSeen` changes for contact, canonical state does not change, different owners lose, and design sections 6-7 state the boundary.
  - Commit: `fix(C6): accept null-bound sensor observations`

### Task 11: E2 — preserve only the exact legacy depth shape

  - Repo/files/tests: `osi-os`; both profile copies of `osi-watermark-helper/commands.js`, production dispatch nodes in both `flows.json` files, `scripts/test-watermark-cloud-command-path.js`, `scripts/test-watermark-cloud-command-auth.js`, the focused replay-chain test from E3, and the rollback/design documents listed in GREEN. Producer reference: cloud `backend/src/main/java/org/osi/server/device/DeviceController.java:1644`, `queueSoilMoistureDepthsSync`.
  - RED: run `node scripts/test-watermark-cloud-command-path.js`, `node scripts/test-watermark-cloud-command-auth.js`, and `node scripts/test-protected-command-replay-chain.js`. Use the producer's actual legacy payload: `deviceEui`, `gatewayDeviceEui`, `soilMoistureProbeDepthsJson`, `soilMoistureProbeDepthsConfigured`, and `syncVersion`. Cover nonempty maps, `{}` clears, and `soilMoistureProbeDepthsConfigured: false` through the shipped dispatch/ledger classification.
  - Invariant: route only the identified legacy shape through its compatibility path. Retain the supplied transport command ID and legacy version semantics. Do not fabricate actor, exact-base version, or protected metadata. Never fall back from malformed protected payloads. Cover replay, foreign binding, and mixed protected/legacy fields. A downgraded edge ignores protected `values`, defaults depths to `{}`, and defaults the configured state to enabled; document that rollback requires a successful fence drain.
  - GREEN: rerun all three scripts, then `node scripts/verify-profile-parity.js`. Stage `AGENTS.md`, both sync-contract Markdown files, the deferred-work index, the original cloud-parity plan, the design, and this review-fix plan in this task's commit. Do not run the full protected-dispatch gate before T1.
  - Commit: `fix(E2): preserve legacy soil depth commands`

### Task 12: E6 — remove dead edge install-capability checks only

  - Repo/files/tests: `osi-os`; protected command applier, both copies of `osi-watermark-helper/commands.js`, `sync-bootstrap-build`, `al-link-build-req`, `sync-force-build`, both profile flows, and existing `capability_missing` tests.
  - RED: run the focused command/auth tests and a static assertion over all three capability builders. Identify the existing `capability_missing` expectations that intentionally change because installation capability is enforced by cloud issuance/delivery.
  - Invariant: remove only the no-op edge install-capability check and its unreachable `capability_missing` results. Preserve `users.disabled_at`, role/grant checks, account linkage, device binding, and identical capability advertisement from all three builders. Do not remove authorization checks or binding conflicts that can occur.
  - GREEN: run `node scripts/test-watermark-cloud-command-path.js`, `node scripts/test-watermark-cloud-command-auth.js`, `node scripts/verify-sync-flow.js`, and `node scripts/verify-profile-parity.js`; require all three builders to advertise identical tokens.
  - Commit: `fix(E6): remove dead edge capability checks`

### Task 13: E4 — install the binding dependency before the ledger

  - Repo/files/tests: `osi-os`; `deploy.sh`, `osi-watermark-binding/canonicalization.js`, command-ledger installation, new `scripts/deploy-command-ledger-dependency.test.js`, and existing `scripts/deploy-fetch-list.test.js`.
  - RED: run `node --test scripts/deploy-command-ledger-dependency.test.js`. Inject a missing binding helper, failed fetch/checksum/rename, interruption after staging, and process interruption between binding and ledger installation. Require a fresh Node process to load the retained ledger and exercise a legacy command after each failure.
  - Invariant: stage and verify both modules before installation; install the binding dependency before the ledger. Retain a runnable prior pair after failure or interruption. Two independent atomic renames do not make the pair atomic: prove intermediate compatibility or use recoverable grouped activation. Never copy live files in place.
  - GREEN: run `node --test scripts/deploy-command-ledger-dependency.test.js scripts/deploy-fetch-list.test.js`, then `bash -n deploy.sh`. Offline bundle fetch discovery must still include every staged dependency.
  - Commit: `fix(E4): install watermark binding before command ledger`

### Task 14: T1 — enforce and raise protected-dispatch timeout floors

  - Repo/files/tests: `osi-os`; `scripts/test-protected-config-command-dispatch.js` and a new static timeout-floor test.
  - RED: run the new static test first; it must fail because the current inner timeout is 60 seconds, below the observed 107-second slow-disk run.
  - Invariant: set every inner timeout in the dispatch script to at least 180 seconds. Do not remove checks, change expected output, or weaken assertions.
  - GREEN: rerun the static test, then `node scripts/test-protected-config-command-dispatch.js`; both must exit 0. No earlier task runs this full gate.
  - Commit: `fix(T1): raise protected dispatch timeout floors`

### Task 15: E1 — restore the exact edge LSN50 owner predicate

  - Repo/files/tests: `osi-os`; both profile copies of `osi-history-helper/index.js`, `osi-history-router/index.js`, their `index.test.js` suites, and `flows.json` for the latest/history-card path; `scripts/test-history-router-soil-projection.js`; and the seam exported by `scripts/capture-history-router-vectors.js`. Keep the committed history-router vectors unchanged.
  - RED: run both router/helper unit suites, `node --test scripts/test-history-router-soil-projection.js`, and `node scripts/capture-history-router-vectors.js --verify`. Add finite-SWT cases for each flag, Chameleon plus flags, plain LSN50 before samples, and an excluded lower-sorting EUI beside a Chameleon. Seed a stale merged soil rollup and mixed-device timestamps that would corrupt latest values, statistics, or cadence if filtering happened after aggregation.
  - Predicate invariant: the helper and router must use the same normalized policy. An LSN50 is eligible exactly when `chameleon_enabled` is true OR `dendro_enabled`, `temp_enabled`, `rain_gauge_enabled`, and `flow_meter_enabled` are all false. Normalize documented aliases before applying that predicate; an alias or finite sample must not bypass exclusion. Filter each device and its unsupported channels before latest-value selection, statistics, and cadence derivation.
  - SWT3 invariant: apply the restriction only to `DRAGINO_LSN50`, whose SWT3 is admitted only when Chameleon-enabled. Preserve existing KIWI/Clover SWT3 behavior, leave `DRAGINO_SDI12` unchanged, and test mixed-zone history/export series and depth labels per device. Apply only the authorized count/list expectation correction; the plain-LSN50-before-samples assertion stays valid.
  - History-card data path: soil history-card reads must bypass legacy merged rows in `history_channel_rollups`, which carry no per-device provenance and cannot be filtered safely. Aggregate the canonical, unpruned `device_data` rows for the full requested window and accept the longer query cost. Leave the generic helper and legacy API surfaces unchanged, preserve rollup reads for non-soil cards, and apply the normalized per-device filter before all future soil rollup generation so new rows are sanitized.
  - GREEN: rerun both unit suites, `node --test scripts/test-history-router-soil-projection.js`, `node scripts/capture-history-router-vectors.js --verify`, and `node scripts/verify-profile-parity.js` without recapturing vectors.
  - Commit: `fix(E1): restore LSN50 soil source eligibility`

### Task 16: C4 — make cloud soil eligibility and root-zone history scope-safe

  - **Decision gate: stop before implementation.** Ask the user to acknowledge both decisions below. The recommended treatment for old root-zone intervals is an honest gap: never serve existing `source_key = 'root-zone'` rollups because they do not identify contributing devices or channel masks; expose no long-range point until the exact current-scope rollup has been rebuilt from raw rows. Keep those legacy rows inert rather than relabelling or deleting them. Separately, the user-authored stop rule requires acknowledgement of two direct expectation changes: `AnalysisCatalogServiceTest` drops from 5 entries to 3 because a temperature-enabled LSN50 no longer contributes two soil entries, and `HistoryRollupMaintenanceServiceTest` drops from 6 units to 4 and must assert that the same device produces no soil request. Approval of the gap policy does not imply approval of those test changes.
  - Repo/files/tests: `osi-server`; frontend device normalization in `frontend/src/services/api.ts`, one shared soil-source policy used by `zoneSensorPresence.ts` and `environment/SoilTab.tsx`, `api.deviceParity.test.ts`, `zoneSoilSummary.test.ts`, a focused Soil-tab test, and `IrrigationZoneCardWaterHonesty.test.tsx`. Backend work spans one shared soil-source policy plus `HistoryCardService`, `HistoryService`, `HistoryAggregationRequest`/`HistoryAggregationService`, `JdbcHistoryRawQueryRepository`, `JdbcHistoryRollupRepository`, `HistoryRollupMaintenanceService`, `AnalysisCatalogService`, and the analysis series read path. Extend their existing unit suites and add a real-PostgreSQL root-zone scope integration test.
  - RED, policy surface: add frontend and backend matrices covering finite SWT values under each exclusion flag, Chameleon plus every flag, a plain LSN50 before its first sample, canonical fields conflicting with aliases, mixed case/whitespace device types, KIWI/Clover SWT3, and unchanged SDI-12 behavior. Put an excluded lower-sorting device beside a Chameleon so ordering cannot hide a post-aggregation filter. Run `npx vitest run src/services/__tests__/api.deviceParity.test.ts src/components/farming/__tests__/zoneSoilSummary.test.ts src/components/farming/__tests__/IrrigationZoneCardWaterHonesty.test.tsx` from `frontend`, then `./gradlew test --tests HistoryCardServiceTest --tests AnalysisCatalogServiceTest --tests HistoryRollupMaintenanceServiceTest` from `backend`; the new assertions must fail before production changes.
  - Shared predicate and channel mask: normalize API aliases once, with canonical-field presence winning even for `false`, `0`, or `null`. Both languages must express the same rule: an LSN50 is a soil source exactly when `chameleon_enabled` is true or all of `dendro_enabled`, `temp_enabled`, `rain_gauge_enabled`, and `flow_meter_enabled` are false. A qualifying non-Chameleon LSN50 exposes SWT1/SWT2; a Chameleon LSN50 also exposes SWT3. Apply this restriction only to `DRAGINO_LSN50`, preserve KIWI/Clover channel behavior, and leave `DRAGINO_SDI12` unchanged. A root-zone contributor must also be active, assigned to the active zone, and free of an explicit device-gateway conflict with the zone; a missing device gateway inherits the zone gateway. Claimant identity does not affect contribution: same-gateway devices owned by another claimant, a former or disabled claimant, and a null claimant remain in the zone aggregate. `zoneSensorPresence`, zone means, trigger-channel means, channel counts, depth lists, Soil-tab values, cards, catalog entries, history queries, exports, and maintenance must all consume this shared predicate and per-device mask before selecting or aggregating samples.
  - Public and internal identity: preserve the public card ID `<zone UUID>:soil:root-zone`, public source key `root-zone`, workspace references, and analysis series IDs. Store scoped root-zone rollups under exactly `soil-root-v1-<24 lowercase SHA-256 hex>`. Hash a policy/version discriminator, immutable zone identity, normalized zone gateway, and the sorted list of `(immutable hashed device source key, sorted allowed channel mask)` contributors. Do not hash a viewer ID, role, grants, display name, or claimant. Owners and enabled gateway members therefore resolve the same canonical zone-wide key, while a contributor or channel-mask change resolves a new key. The public response must never expose the internal key.
  - Raw SQL boundary: pass the resolved contributor manifest into `JdbcHistoryRawQueryRepository` and join an allowed `(device_id, channel_key)` relation before JSON-channel expansion, ordering, or `LIMIT`. The query must also enforce the current active-zone assignment and device gateway-compatibility predicate; filtering a `HistoryRawPoint` after the query has already dropped device identity is forbidden. Apply the same rule to visible history, export, and rollup-backfill reads. Add a 30,000-row boundary test in which excluded rows sort first: all permitted inputs up to the documented cap remain available, excluded rows consume none of the cap, and the export overflow sentinel is calculated after eligibility filtering.
  - Rollup reads and writes: `HistoryAggregationService` may read root-zone soil rollups only through the exact `soil-root-v1-*` key for the current contributor manifest. `JdbcHistoryRollupRepository` must never fall back to or mix the legacy unscoped `root-zone` rows. Maintenance builds each scoped root-zone bucket directly from eligible raw samples under one manifest and writes only its internal key; it must not combine device rollup medians or derive a new median from stored medians. A scope change creates a different key. Until maintenance backfills that key, long-range responses contain transparent gaps while short-range reads continue from filtered raw data.
  - Authorization and current-scope revalidation: cached catalog membership is not authorization. Authorize the viewer as the zone owner or an enabled member of the zone gateway before resolving the canonical contributor manifest; keep card preferences viewer-specific and outside that manifest. After a raced rollup fetch, recheck both viewer authorization and the contributor manifest. Reject immediately if authorization was revoked. If only the manifest changed, discard the fetched points and retry once or return an honest gap. A maintenance job that races reassignment, deletion, gateway correction, or flag change may finish only under its old key, which current reads cannot address.
  - PostgreSQL evidence: add a Testcontainers-backed integration test over real `devices`, `sensor_data`, and `history_channel_rollups`. Prove flag and SWT3 filtering before aggregation; scope-key stability under input reordering; owner and enabled gateway member resolution to the same key; claimant independence, including other, former, disabled, and null claimants; missing gateway inheritance; explicit gateway-conflict exclusion; key changes after flag, assignment, deletion, or gateway correction; old-key invisibility; exact-scope backfill; no legacy-row fallback; and no median-of-medians path. Add two-transaction races for contributor change and viewer authorization revocation while a root-zone read/backfill is in flight. A response may contain one coherent authorized manifest or an empty gap, never a mixture or post-revocation data. The same test must exercise the 30,000-row eligible-input boundary against PostgreSQL rather than SQL-string inspection alone.
  - Authorized expectation changes after the gate: update the Water-honesty assertions already identified in review. Change `AnalysisCatalogServiceTest` from 5 to 3 entries and remove the two soil leaves for the temperature-enabled LSN50. Change `HistoryRollupMaintenanceServiceTest` from 6 to 4 units and assert that device has only its two environment requests, with no soil request. Do not adjust any other stale assertion without pausing and reporting its exact arithmetic cause.
  - GREEN: rerun every focused frontend test above plus the new Soil-tab test and `npx tsc --noEmit`. From `backend`, run the focused service, aggregation, raw-query, rollup-repository, maintenance, catalog, and analysis-series unit suites, followed by the new PostgreSQL integration test. Require the PostgreSQL test to run rather than skip. Then run the full frontend Vitest suite and `./gradlew test --no-daemon -x buildFrontend -x buildTerraIntelligenceFrontend` before committing.
  - Commit: `fix(C4): scope cloud root-zone soil history`

## Final verification

Run every command from its repository root unless it names another directory. Each command starts there independently; do not carry a preceding `cd` into the next line. Record exit code and test count for each test runner.

### `osi-os`

Execute every current project verification command in `.github/workflows/`, including complete multiline `run` blocks, preserving workflow working directories, environment variables, and matrix variants. Source the inventory from `codecs.yml`, `field-journal.yml`, `history-router.yml`, `journal-catalog.yml`, `migrations.yml`, `typecheck.yml`, `ui-core.yml`, and `verify-sync-flow.yml`. Record each workflow/step, command, effective directory/environment, exit code, and test count. Use the paired integration checkout wherever a workflow provisions its sister repository; preserve the validation command and record that checkout substitution. Toolchain/setup steps require equivalent local prerequisites. Do not replace this inventory with the shorter list below or run checkout steps that overwrite integration worktrees. Keep the no-push/no-deploy/no-host boundary.

Run these explicit gates as well; an identical workflow invocation with the same environment may provide their evidence:

```bash
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-strega-gen1.js
node scripts/verify-lorain-codec.js
node scripts/verify-communication-contract.js
scripts/check-mqtt-topics.sh
node --test scripts/test-gateway-health-persistence.js
node scripts/capture-history-router-vectors.js --verify
node --test lib/osi-migrate/*.test.js
node --test scripts/reconcile-ledger-numbering.test.js
node --test scripts/verify-seed-replay.test.js
node scripts/test-watermark-cloud-command-path.js
node scripts/test-watermark-cloud-command-auth.js
node scripts/test-protected-command-replay-chain.js
node scripts/test-protected-config-command-dispatch.js
node --test scripts/deploy-command-ledger-dependency.test.js scripts/deploy-fetch-list.test.js
node scripts/verify-profile-parity.js
node scripts/verify-runtime-schema-parity.js
cd web/react-gui && npx tsc --noEmit
cd web/react-gui && npm run test:unit
cd web/react-gui && npm run build
git diff --check
```

Verify flow preservation with a private temporary directory: extract node `d0b2b1c1a937e16d` from `origin/main` and both profile `flows.json` files using the same canonical JSON serializer, then run `cmp` on the three outputs. Run `cmp` directly on the two complete profile flow files as well. All comparisons must exit 0.

### `osi-server`

```bash
cd backend && ./gradlew test --no-daemon -x buildFrontend -x buildTerraIntelligenceFrontend
cd backend && ./gradlew archTest --no-daemon -x buildFrontend -x buildTerraIntelligenceFrontend
cd backend && ./gradlew build -x bootJar
cd frontend && npx tsc --noEmit
cd frontend && npx vitest run
cd terra-intelligence && npx tsc --noEmit
cd terra-intelligence && npx vitest run
sh scripts/verify-flyway-ordering.test.sh
sh scripts/verify-flyway-ordering.sh
node --test scripts/verify-flyway-target.test.mjs
EDGE_CONTRACT_ROOT="$EDGE_WORKTREE" sh scripts/verify-edge-sync-contract-vendor.sh
sh scripts/verify-edge-sync-contract-vendor.test.sh
OSI_OS_REPO="$EDGE_WORKTREE" node scripts/verify-channel-manifest-sync.js
git diff --check
```

Run the focused tests added in every task, including the Spring/Postgres integration cases, even if the general Gradle selection excludes their class names. Supply `EDGE_CONTRACT_ROOT` for `SyncContractVendorTest`; its direct `commands.schema.json` assertion is required in addition to the shell vendor check. Run backend/frontend builds sequentially.

Return a table with finding ID, commit hash, proving test, and one-line fix. Then state the C2 rule, anything not fixed and why, both final heads, and every gate's exit code and test count.
