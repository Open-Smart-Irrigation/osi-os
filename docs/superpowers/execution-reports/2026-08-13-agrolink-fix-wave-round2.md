# AgroLink fix wave Round 2 execution report

Date: 2026-08-13  
Edge worktree: `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep`  
Cloud worktree: `/home/phil/Repos/osi-server/.worktrees/agrolink`

R1–R8 were implemented as local commits. No push, deploy, live gateway, or production-cloud access was used.

## Task commits

| Row | Repository | Commit | Result |
|---|---|---|---|
| R1 | edge | `deae7196` | Restored the AddDeviceModal E1 test. It waits for the rendered `Strega valve` option, selects `STREGA_VALVE`, and asserts that type is submitted. |
| R2 | edge | `2d1add36` | Restored the GUI workflow `defaults.run.working-directory: web/react-gui`; YAML parsing confirmed the three npm steps are nested under it. |
| R3 | edge | `1e7f2fe5` | Pinned the seven staged cloud-deferred event operations exactly. Contract schema, sync-contract, and sync-op parity checks pass. |
| R4 | edge | `f3128352` | Added `osiLib` seams to the history-vector and STREGA Gen1 harnesses, plus the async/database seam exposed by the STREGA run. Both verifiers exit 0. |
| R5 | edge + cloud | `a79460f8` + `574567a3` | Copied the golden contract byte-for-byte and added an optional warning-only cross-check when the cloud checkout is unavailable. The paired check reports byte-identical copies. SHA-256: `f29f776ab8c5e39c49f720c5cb41998f2cbf5ed45a3eb2fa8a621029d702921a`. |
| R6 | cloud | `1c12649c` | Deleted and recreated the ArchUnit store with both creation and update flags temporarily enabled, then restored both flags to `false`. The review found the identical 1,402-cycle set, zero added, zero removed, and constructor-signature text churn only. |
| R7 | cloud | `33726f30` | Changed the zone fixture device claim to a non-owner user. The regression is now non-vacuous. |
| R8 | edge | `f6b31626` | Reworked scoped cloud registration for unclaimed, same-owner, and cross-owner existing devices; gated scoped ACK vocabulary; and pinned the W4 zone precondition behavior. |

## Mutation evidence

- R1 baseline passed with four tests. After mutating `AddDeviceModal.tsx` from `selectedType` to `catalog[0]?.id`, the targeted test failed with expected `STREGA_VALVE` and received `DRAGINO_LSN50`. The mutation was undone; the targeted test passed again.
- R7 passed before mutation. Restoring both owner filters caused the non-owner fixture test to fail with `PotentialStubbingProblem`; the mutation was undone and the test passed again.
- R8 red-first probes failed before the implementation: same-owner registration did not provision, an unclaimed row stayed unclaimed, flag-off ACK bytes included scoped verification detail, and the W4 replay made zero provisioning calls. The implementation made the full scoped-access write suite pass (70 tests).
- R8 W4 mutation removed only `AND irrigation_zone_id IS NULL` from the guarded zone UPDATE. The behavioral test then failed because the device moved from zone 1 to zone 2 (`expected 1, actual 2`). Restoring the guard returned the test to green.

The R1 AddDeviceModal change is an E1 scope extension, not a deviation. The task goal is that the submitted type is the user’s selection. A submit during the catalog-loading window that sends an arbitrary default violates that goal in the same way as submitting `catalog[0]`; the second modal therefore receives the same fail-closed guard and regression coverage.

## R8 behavior

Scoped `REGISTER_DEVICE` now loads the existing device regardless of `deleted_at`. An unclaimed row is assigned to the resolved local user, revived, provisioned, and assigned through the existing guarded zone UPDATE. A same-owner row is re-provisioned so missing or zero keys can be repaired. A cross-owner claim returns terminal `ALREADY_CLAIMED` before any ChirpStack call or local mutation.

`ALREADY_REGISTERED`, `verificationRequired`, and the zone-result fields are emitted only with `OSI_SCOPED_ACCESS=1`. Flag-off registration retains the legacy `APPLIED` ACK and the byte-pinned legacy payload shape. The zone replay test keeps the requested `zoneUuid` while the row-wise `irrigation_zone_id IS NULL` precondition prevents a replay from moving an already assigned device.

## Verification

Green edge gates include:

- `node scripts/verify-sync-flow.js`, including the explicit paired cloud service path.
- `node scripts/verify-flows-fn-parse.js`, `verify-scoped-access.js`, `verify-flows-size-ratchet.js`, `verify-profile-parity.js`, `check-mqtt-topics.sh`, and the sync-contract/parity checks.
- `node scripts/verify-seed-replay.js` and the path-pinned dendro and prediction-catalog verifiers.
- Scoped reads: 39 tests; scoped writes: 70 tests; scoped command path: 5 tests.
- Device, irrigation-config, and zone command-path suites: 3, 3, and 7 tests.
- Journal API: 69; journal command path: 64; journal lifecycle: 118; journal V2 worker: 14; journal V2 replication: 12.
- Edge frontend: 1,721 Vitest tests and 128 TSX-runner tests passed through `npm run test:unit`.
- Cloud backend: `./gradlew cleanTest test --no-daemon` exited 0. The clean result contains 1,609 passed and one skipped `JournalScannerBridgeIT` ClamAV EICAR integration test. Cloud frontend `npm run test:unit` passed 715 tests.

The full edge sweep is not fully green. The following failures remain outside the R8 code path and were not changed:

- `test-flows-wiring.js` / `test-journal-bootstrap.js`: 59/62 pass; three history-router close/features assertions fail.
- `test-device-api-auth-status.js`: 75/79 pass; the four failures expose missing `osiLib` in the broad auth harness.
- `test-error-recording-flow.js`: the two structural checks see two wires for `record-error-catch-auth`; both runtime checks pass.
- `test-sync-outbox-json-guard.js`: the migration harness refuses the current `history-api-router-fn` source hash.
- `verify-lsn50-chameleon-swt.js`: it calls the removed `calibrationFromDeviceRow` export.
- `verify-built-factory-image-provenance.js`: no `--rootfs` and `--profile` were supplied because this run has no built rootfs.

The STREGA Gen1 `osiLib is not defined` failure predated this wave; R4 supplies the missing harness dependency and the verifier now exits 0.

The Round 1 report’s two numbers are corrected here as requested: its cloud count was **1,608 passed**, not 1,609, because that run had one ArchUnit failure and one skip. The ArchUnit failure was introduced by the wave, not pre-existing. After R6’s refreeze, the clean Round 2 run is green; the anonymous skip is the ClamAV EICAR integration test.

## Deferred rows

R9–R14 remain deferred:

- R9: runtime-gate the calibration and weather-station trigger families, or document cloud-first rollout as the sole guard.
- R10: pin the destination-plot authorization check and enforce ownership for plotless voids.
- R11: complete cloud sync hardening for aggregate-key/device-EUI consistency, unseen-EUI claiming, ownerless mirror writes, and journal ownership SQL coverage.
- R12: resolve NULL gateway-EUI messaging and assignment semantics, then add the C6 mismatch-modal coverage.
- R13: wire the remaining CI suites, pin cross-repo parity to a SHA, mirror command tests, and fix the provenance workflow concurrency residue.
- R14: retain the report corrections, add the remaining HistoryDashboard and Uganda-language coverage, and correct the `lg` hexadecimal rendering.
